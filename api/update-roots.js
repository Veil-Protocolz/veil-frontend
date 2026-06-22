/**
 * POST /api/update-roots
 *
 * Phase 1 (no body): returns on-chain commitments so the frontend can compute root
 * Phase 2 (body: { root, leaves }): submits update_pool_root + update_asp_root
 *
 * Required env var: ADMIN_SECRET_KEY
 */

import {
  Keypair,
  TransactionBuilder,
  Networks,
  Contract,
  xdr,
  rpc as SorobanRpc,
} from "@stellar/stellar-sdk";

const POOL_CONTRACT =
  process.env.POOL_CONTRACT ||
  "CCSA4Q3DZ3FGABTATGWKE3EMNT6YKTUJNI7JACDX4336FJCYJJIG3KGW";
const NETWORK = process.env.STELLAR_NETWORK || "testnet";
const RPC_URL =
  NETWORK === "mainnet"
    ? "https://soroban-mainnet.stellar.org"
    : "https://soroban-testnet.stellar.org";
const PASSPHRASE =
  NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

async function getCommitmentsFromChain(server) {
  const contract = new Contract(POOL_CONTRACT);
  const kp = Keypair.random();
  const account = {
    accountId: () => kp.publicKey(),
    sequenceNumber: () => "0",
    incrementSequenceNumber() {},
  };
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: PASSPHRASE })
    .addOperation(contract.call("get_commitments"))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  const val = SorobanRpc.Api.isSimulationSuccess(sim) ? sim.result?.retval : null;
  if (!val || val.switch().name !== "scvVec") return [];
  return val.vec().map((v) =>
    "0x" + Buffer.from(v.bytes()).toString("hex")
  );
}

async function submitRootUpdate(server, adminKp, fn, rootHex) {
  const account = await server.getAccount(adminKp.publicKey());
  const contract = new Contract(POOL_CONTRACT);
  const rootBytes = Buffer.from(rootHex.replace("0x", "").padStart(64, "0"), "hex");

  const tx = new TransactionBuilder(account, { fee: "10000000", networkPassphrase: PASSPHRASE })
    .addOperation(
      contract.call(
        fn,
        xdr.ScVal.scvAddress(
          xdr.ScAddress.scAddressTypeAccount(
            xdr.PublicKey.publicKeyTypeEd25519(adminKp.rawPublicKey())
          )
        ),
        xdr.ScVal.scvBytes(rootBytes)
      )
    )
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim))
    throw new Error("Sim failed: " + sim.error);

  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(adminKp);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR")
    throw new Error("TX rejected: " + send.errorResultXdr);

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") return send.hash;
    if (poll.status === "FAILED")
      throw new Error(fn + " failed on-chain");
  }
  throw new Error(fn + " timed out");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }

  const adminSecret = process.env.ADMIN_SECRET_KEY;
  if (!adminSecret) {
    res.status(500).json({ error: "ADMIN_SECRET_KEY not set" });
    return;
  }

  try {
    const server = new SorobanRpc.Server(RPC_URL);
    const adminKp = Keypair.fromSecret(adminSecret);

    const rootHex = req.body?.root;
    const leaves = req.body?.leaves ?? null;

    if (!rootHex) {
      const commitments = await getCommitmentsFromChain(server);
      res.status(200).json({ ok: false, needsRoot: true, commitments });
      return;
    }

    const clean = rootHex.replace("0x", "");
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
      res.status(400).json({ error: "Invalid root format" });
      return;
    }

    console.log("Updating pool root to", clean.slice(0, 16) + "...");
    const poolTx = await submitRootUpdate(server, adminKp, "update_pool_root", rootHex);

    console.log("Updating ASP root...");
    const aspTx = await submitRootUpdate(server, adminKp, "update_asp_root", rootHex);

    res.status(200).json({
      ok: true,
      root: "0x" + clean,
      leaves: leaves ?? "?",
      poolTx,
      aspTx,
    });
  } catch (e) {
    console.error("update-roots error:", e);
    res.status(500).json({ error: e.message });
  }
}
