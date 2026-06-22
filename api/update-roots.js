/**
 * Vercel serverless function — called by the frontend after every deposit.
 * Reads all commitments from the pool contract, computes the new Merkle root
 * using Poseidon (WASM), and calls update_pool_root + update_asp_root on-chain.
 *
 * Required env vars (set in Vercel dashboard):
 *   ADMIN_SECRET_KEY   — Stellar secret key of the pool admin (alice)
 *   POOL_CONTRACT      — Pool contract ID
 *   STELLAR_NETWORK    — "testnet" or "mainnet"
 */

const fs = require("fs");
const path = require("path");
const {
  Keypair,
  TransactionBuilder,
  Networks,
  Contract,
  xdr,
  rpc: SorobanRpc,
} = require("@stellar/stellar-sdk");

const CIRCUITS = path.join(__dirname, "circuits");
const LEVELS = 20;

// ---- Poseidon WASM loader ----
const _wcCache = {};
async function loadWC(name) {
  if (_wcCache[name]) return _wcCache[name];
  const wcSrc = fs.readFileSync(path.join(CIRCUITS, "witness_calculator.js"), "utf8");
  const wasm  = fs.readFileSync(path.join(CIRCUITS, `${name}.wasm`));
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", wcSrc)(mod, mod.exports);
  const builder = mod.exports.default ?? mod.exports;
  const wc = await builder(wasm);
  _wcCache[name] = wc;
  return wc;
}

async function poseidon2(a, b) {
  const wc = await loadWC("poseidon_helper");
  const w = await wc.calculateWitness({ a: a.toString(), b: b.toString() }, false);
  return w[1];
}

// ---- Merkle tree ----
let _zeros = null;
async function getZeros() {
  if (_zeros) return _zeros;
  _zeros = new Array(LEVELS + 1);
  _zeros[0] = 0n;
  for (let i = 1; i <= LEVELS; i++) _zeros[i] = await poseidon2(_zeros[i - 1], _zeros[i - 1]);
  return _zeros;
}

async function computeRoot(leaves) {
  const zeros = await getZeros();
  let layer = leaves.slice();
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    const next = [];
    const size = Math.max(Math.ceil(layer.length / 2), 1);
    for (let i = 0; i < size; i++) {
      const l = layer[i * 2]     ?? zeros[lvl];
      const r = layer[i * 2 + 1] ?? zeros[lvl];
      next.push(await poseidon2(l, r));
    }
    layer = next;
  }
  return layer[0] ?? zeros[LEVELS];
}

// ---- Read commitments from on-chain ----
async function fetchCommitments(server, contractId, networkPassphrase) {
  const contract = new Contract(contractId);
  const kp = Keypair.random();
  const account = {
    accountId: () => kp.publicKey(),
    sequenceNumber: () => "0",
    incrementSequenceNumber() {},
  };
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase })
    .addOperation(contract.call("get_commitments"))
    .setTimeout(10)
    .build();
  const sim = await server.simulateTransaction(tx);
  const val = SorobanRpc.Api.isSimulationSuccess(sim) ? sim.result?.retval : null;
  if (!val || val.switch().name !== "scvVec") return [];
  return val.vec().map(v => BigInt("0x" + Buffer.from(v.bytes()).toString("hex")));
}

// ---- Call update_pool_root or update_asp_root ----
async function updateRoot(server, contractId, networkPassphrase, adminKp, fn, newRoot) {
  const account = await server.getAccount(adminKp.publicKey());
  const contract = new Contract(contractId);
  const rootHex = newRoot.toString(16).padStart(64, "0");
  const rootBytes = Buffer.from(rootHex, "hex");

  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase })
    .addOperation(contract.call(
      fn,
      xdr.ScVal.scvAddress(
        xdr.ScAddress.scAddressTypeAccount(
          xdr.PublicKey.publicKeyTypeEd25519(adminKp.rawPublicKey())
        )
      ),
      xdr.ScVal.scvBytes(rootBytes),
    ))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) throw new Error("Sim failed: " + sim.error);

  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(adminKp);
  const send = await server.sendTransaction(prepared);

  // Poll for confirmation
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") return send.hash;
    if (poll.status === "FAILED") throw new Error(`${fn} failed: ` + poll.resultXdr);
  }
  throw new Error(`${fn} timed out`);
}

// ---- Handler ----
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const adminSecret  = process.env.ADMIN_SECRET_KEY;
  const contractId   = process.env.POOL_CONTRACT   || "CCSA4Q3DZ3FGABTATGWKE3EMNT6YKTUJNI7JACDX4336FJCYJJIG3KGW";
  const network      = process.env.STELLAR_NETWORK  || "testnet";

  if (!adminSecret) {
    res.status(500).json({ error: "ADMIN_SECRET_KEY not configured" });
    return;
  }

  const rpcUrl = network === "mainnet"
    ? "https://soroban-mainnet.stellar.org"
    : "https://soroban-testnet.stellar.org";
  const networkPassphrase = network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

  try {
    const server  = new SorobanRpc.Server(rpcUrl);
    const adminKp = Keypair.fromSecret(adminSecret);

    console.log("Fetching commitments from", contractId);
    const leaves = await fetchCommitments(server, contractId, networkPassphrase);
    console.log("Commitments:", leaves.length);

    console.log("Computing Merkle root…");
    const newRoot = await computeRoot(leaves);
    console.log("New root:", newRoot.toString(16));

    console.log("Updating pool root…");
    const poolTx = await updateRoot(server, contractId, networkPassphrase, adminKp, "update_pool_root", newRoot);

    console.log("Updating ASP root…");
    const aspTx  = await updateRoot(server, contractId, networkPassphrase, adminKp, "update_asp_root",  newRoot);

    res.status(200).json({
      ok: true,
      root: "0x" + newRoot.toString(16).padStart(64, "0"),
      leaves: leaves.length,
      poolTx,
      aspTx,
    });
  } catch (e) {
    console.error("update-roots error:", e);
    res.status(500).json({ error: e.message });
  }
};
