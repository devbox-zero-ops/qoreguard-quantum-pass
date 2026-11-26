import { useEffect, useMemo, useState } from "react";
import { createClient, qorToEvm, type QoreChainClient } from "@qorechain/sdk";

const REST_URL = import.meta.env.DEV
  ? (import.meta.env.VITE_QORE_REST_URL ?? "/lcd")
  : "https://api-testnet.qore.host";
const EVM_RPC_URL =
  import.meta.env.VITE_QORE_EVM_RPC_URL ?? "https://evm-testnet.qore.host";
const SAMPLE_TESTNET_ADDRESS = "qor1j9gj92ffkmud24p4uzszexhqnuy0dq9sf5ymwp";

interface Balance {
  denom: string;
  amount: string;
}

interface QoreXProvider {
  request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  enable?: () => Promise<string[]>;
  getKey?: (chainId: string) => Promise<{ bech32Address?: string; name?: string }>;
}

declare global {
  interface Window {
    qorex?: QoreXProvider;
    ethereum?: QoreXProvider & { isQoreX?: boolean };
  }
}

function formatQor(uqorStr: string, compact = false): string {
  const n = Number(uqorStr);
  if (!Number.isFinite(n)) return uqorStr;
  const qor = n / 1_000_000;
  if (compact) {
    if (qor >= 1e12) return `${(qor / 1e12).toFixed(2)}T QOR`;
    if (qor >= 1e9) return `${(qor / 1e9).toFixed(2)}B QOR`;
    if (qor >= 1e6) return `${(qor / 1e6).toFixed(2)}M QOR`;
    if (qor >= 1e3) return `${(qor / 1e3).toFixed(2)}K QOR`;
  }
  return qor.toLocaleString(undefined, { maximumFractionDigits: 4 }) + " QOR";
}

export function App(): JSX.Element {
  const client: QoreChainClient = useMemo(
    () =>
      createClient({
        network: "testnet",
        endpoints: { rest: REST_URL, evmRpc: EVM_RPC_URL },
      }),
    [],
  );

  const [walletAddr, setWalletAddr] = useState<string>("");
  const [address, setAddress] = useState<string>("");
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [pqcStatus, setPqcStatus] = useState<Record<string, unknown> | null>(null);
  const [pqcAccount, setPqcAccount] = useState<Record<string, unknown> | null>(null);
  const [tokenomics, setTokenomics] = useState<Record<string, unknown> | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const hasQoreX = typeof window !== "undefined" && Boolean(window.qorex || window.ethereum);

  useEffect(() => {
    void loadTokenomics();
  }, []);

  async function connectQoreX(): Promise<void> {
    setError(null);
    const provider = window.qorex ?? window.ethereum;
    if (!provider) {
      setError("QoreX wallet extension not detected. Install QoreX and switch to Testnet (qorechain-diana).");
      return;
    }
    setLoading(true);
    try {
      let addr = "";
      if (provider.getKey) {
        const key = await provider.getKey(client.network.chainId ?? "qorechain-diana");
        addr = key?.bech32Address ?? "";
      }
      if (!addr && provider.request) {
        const res = (await provider.request({ method: "eth_requestAccounts" })) as string[];
        addr = res?.[0] ?? "";
      }
      if (!addr && provider.enable) {
        const res = await provider.enable();
        addr = res?.[0] ?? "";
      }
      if (!addr) throw new Error("No account returned by QoreX provider.");
      setWalletAddr(addr);
      setAddress(addr);
      await inspectAddress(addr);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function inspectAddress(targetAddr?: string): Promise<void> {
    const target = (targetAddr ?? address).trim();
    setError(null);
    setBalances(null);
    setPqcStatus(null);
    setPqcAccount(null);
    if (!target) {
      setError("Enter a qor1... or 0x... testnet address.");
      return;
    }
    setLoading(true);
    try {
      const evmAddr = target.startsWith("qor1") ? qorToEvm(target) : target;
      const evmBalPromise = fetch(EVM_RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBalance",
          params: [evmAddr, "latest"],
        }),
      }).then((r) => r.json() as Promise<{ result?: string; error?: { message?: string } }>);

      const pqcStatusPromise = client.qor.getPqcKeyStatus(target);

      const [evmBalRes, statusRes] = await Promise.allSettled([evmBalPromise, pqcStatusPromise]);

      if (evmBalRes.status === "fulfilled" && evmBalRes.value?.result) {
        const wei = BigInt(evmBalRes.value.result);
        const uqor = wei / 1_000_000_000_000n;
        setBalances([{ denom: "uqor", amount: uqor.toString() }]);
      } else if (import.meta.env.DEV) {
        const restBal = await client.rest.getAllBalances(target);
        setBalances((restBal.balances as Balance[]) ?? []);
      } else {
        setBalances([]);
      }

      if (statusRes.status === "fulfilled") {
        setPqcStatus(statusRes.value as Record<string, unknown>);
      }

      if (import.meta.env.DEV) {
        try {
          const acc = await client.rest.getPqcAccount(target);
          setPqcAccount(acc as Record<string, unknown>);
        } catch {
          // ignore optional rest lookup
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function sendHybridSelfCheck(): Promise<void> {
    setError(null);
    setTxHash(null);
    const provider = window.qorex ?? window.ethereum;
    if (!provider?.request || !walletAddr) {
      setError("Connect QoreX wallet first to sign a hybrid-signed proof transaction.");
      return;
    }
    setLoading(true);
    try {
      const hash = (await provider.request({
        method: "qor_sendTransaction",
        params: [
          {
            from: walletAddr,
            to: walletAddr,
            value: "0x1",
            data: "0x516f72654775617264", // "QoreGuard"
          },
        ],
      })) as string;
      setTxHash(String(hash));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadTokenomics(): Promise<void> {
    try {
      const overview = await client.qor.getTokenomicsOverview();
      setTokenomics(overview as Record<string, unknown>);
    } catch {
      // Keep UI responsive if local dev proxy is not running
    }
  }

  function downloadAuditJson(): void {
    const payload = {
      network: client.network.chainId,
      inspected_at: new Date().toISOString(),
      address: address.trim() || null,
      balances,
      pqcKeyStatus: pqcStatus,
      pqcAccount,
      tokenomics,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qoreguard-audit-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const burnStats = (tokenomics?.burn as Record<string, unknown> | undefined)?.stats as
    | Record<string, unknown>
    | undefined;
  const burnsBySource = (burnStats?.burns_by_source as Record<string, string> | undefined) ?? {};

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(160deg, #0b1020 0%, #121a31 55%, #0f172a 100%)",
        color: "#e2e8f0",
        fontFamily: "Inter, system-ui, -apple-system, sans-serif",
        padding: "2rem 1rem",
      }}
    >
      <main style={{ maxWidth: 880, margin: "0 auto" }}>
        <header
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "1rem",
            paddingBottom: "1.5rem",
            borderBottom: "1px solid rgba(148,163,184,0.2)",
          }}
        >
          <div>
            <div style={{ fontSize: 12, letterSpacing: "0.1em", color: "#38bdf8", fontWeight: 700 }}>
              QORECHAIN QUANTUM PASS &middot; {client.network.chainId}
            </div>
            <h1 style={{ margin: "0.25rem 0 0", fontSize: "1.8rem", color: "#f8fafc" }}>
              QoreGuard Post-Quantum Readiness Inspector
            </h1>
          </div>
          <button
            onClick={connectQoreX}
            disabled={loading}
            style={{
              background: walletAddr ? "#10b981" : "#38bdf8",
              color: "#0b1020",
              border: "none",
              borderRadius: 10,
              padding: "0.7rem 1.2rem",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {walletAddr
              ? `Connected: ${walletAddr.slice(0, 8)}...${walletAddr.slice(-6)}`
              : hasQoreX
              ? "Connect QoreX Wallet"
              : "Connect QoreX (Testnet)"}
          </button>
        </header>

        <section
          style={{
            marginTop: "1.5rem",
            background: "rgba(30, 41, 59, 0.72)",
            border: "1px solid rgba(148,163,184,0.2)",
            borderRadius: 14,
            padding: "1.25rem",
          }}
        >
          <h2 style={{ margin: "0 0 0.75rem", fontSize: "1.1rem" }}>
            1. Address Balance &amp; ML-DSA-87 PQC Registration Audit
          </h2>
          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Enter qor1... or 0x... QoreChain Testnet address"
              aria-label="QoreChain address"
              style={{
                flex: 1,
                minWidth: 260,
                padding: "0.65rem 0.85rem",
                borderRadius: 8,
                border: "1px solid rgba(148,163,184,0.3)",
                background: "#0f172a",
                color: "#f8fafc",
              }}
            />
            <button
              onClick={() => void inspectAddress()}
              disabled={loading}
              style={{
                background: "#6366f1",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "0.65rem 1.1rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Inspect PQC &amp; Balance
            </button>
            <button
              onClick={() => {
                setAddress(SAMPLE_TESTNET_ADDRESS);
                void inspectAddress(SAMPLE_TESTNET_ADDRESS);
              }}
              disabled={loading}
              style={{
                background: "#1e293b",
                color: "#e2e8f0",
                border: "1px solid rgba(148,163,184,0.35)",
                borderRadius: 8,
                padding: "0.65rem 0.95rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Load Sample Address
            </button>
            <button
              onClick={downloadAuditJson}
              disabled={loading || (!pqcStatus && !tokenomics)}
              style={{
                background: "#0f766e",
                color: "#f8fafc",
                border: "none",
                borderRadius: 8,
                padding: "0.65rem 0.95rem",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Download Audit JSON
            </button>
            <button
              onClick={sendHybridSelfCheck}
              disabled={loading || !walletAddr}
              style={{
                background: walletAddr ? "#f59e0b" : "#334155",
                color: walletAddr ? "#0b1020" : "#94a3b8",
                border: "none",
                borderRadius: 8,
                padding: "0.65rem 1.1rem",
                fontWeight: 600,
                cursor: walletAddr ? "pointer" : "not-allowed",
              }}
            >
              Send Hybrid-Signed Proof Tx
            </button>
          </div>

          {txHash && (
            <p style={{ marginTop: "0.9rem", color: "#34d399" }}>
              Hybrid-signed transaction submitted: <code>{txHash}</code>
            </p>
          )}

          {balances && (
            <div style={{ marginTop: "1rem" }}>
              <strong>Balances:</strong>{" "}
              {balances.length === 0
                ? "0 QOR"
                : balances.map((b) => `${formatQor(b.amount)} (${b.denom})`).join(", ")}
            </div>
          )}

          {(pqcStatus || pqcAccount) && (
            <pre
              style={{
                marginTop: "0.9rem",
                background: "#0b1020",
                padding: "0.9rem",
                borderRadius: 8,
                overflowX: "auto",
                fontSize: 12.5,
              }}
            >
              {JSON.stringify({ pqcKeyStatus: pqcStatus, pqcAccount }, null, 2)}
            </pre>
          )}
        </section>

        <section
          style={{
            marginTop: "1.25rem",
            background: "rgba(30, 41, 59, 0.72)",
            border: "1px solid rgba(148,163,184,0.2)",
            borderRadius: 14,
            padding: "1.25rem",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, fontSize: "1.1rem" }}>
              2. Live QoreChain Testnet Tokenomics &amp; Burn Telemetry
            </h2>
            <button
              onClick={() => void loadTokenomics()}
              disabled={loading}
              style={{
                background: "transparent",
                color: "#38bdf8",
                border: "1px solid #38bdf8",
                borderRadius: 8,
                padding: "0.4rem 0.85rem",
                cursor: "pointer",
              }}
            >
              Refresh
            </button>
          </div>
          {burnStats ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                gap: "0.75rem",
                marginTop: "1rem",
              }}
            >
              <div
                style={{ background: "#0f172a", padding: "0.85rem", borderRadius: 10 }}
                title={formatQor(String(burnStats.total_burned ?? "0"))}
              >
                <div style={{ fontSize: 12, color: "#94a3b8" }}>Total Burned</div>
                <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4 }}>
                  {formatQor(String(burnStats.total_burned ?? "0"), true)}
                </div>
              </div>
              {Object.entries(burnsBySource)
                .filter(([, v]) => v !== "0")
                .slice(0, 5)
                .map(([k, v]) => (
                  <div
                    key={k}
                    style={{ background: "#0f172a", padding: "0.85rem", borderRadius: 10 }}
                    title={formatQor(v)}
                  >
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>Burn: {k}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>{formatQor(v, true)}</div>
                  </div>
                ))}
            </div>
          ) : (
            <p style={{ color: "#94a3b8", marginTop: "0.75rem" }}>
              Loading live <code>qor_getTokenomicsOverview</code> from testnet...
            </p>
          )}
        </section>

        {error && (
          <p style={{ color: "#fb7185", marginTop: "1rem", fontWeight: 600 }} role="alert">
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
