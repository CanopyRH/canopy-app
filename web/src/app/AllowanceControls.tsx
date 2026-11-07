import { useEffect, useState } from "react";
import type { Address } from "viem";
import type { Net, Signer } from "../chain";
export function AllowanceControls({
  net,
  owner,
  signer,
  busy,
  act,
}: {
  net: Net;
  owner: Address | null;
  signer: Signer | null;
  busy: boolean;
  act: (fn: () => Promise<{ text: string }>) => void;
}) {
  const [vault, setVault] = useState(net.chain.vaults[0]?.address ?? ""),
    [accepted, setAccepted] = useState(false),
    [value, setValue] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0);
  const mine =
    net.live &&
    owner &&
    signer &&
    owner.toLowerCase() === signer.account.toLowerCase();
  useEffect(() => {
    let current = true;
    setValue(null);
    setAccepted(false);
    if (mine && vault)
      void net.allowanceOf(owner!, vault as Address).then(
        (n) => current && setValue(n.toString()),
        () => current && setValue("unreadable"),
      );
    return () => {
      current = false;
    };
  }, [net, owner, mine, vault, refresh]);
  return (
    <section className="cd-glass cd-settings-main cd-allowance-controls">
      <div className="cd-card-top">
        <div>
          <h2>Revoke a vault allowance</h2>
          <p className="cd-caption">
            Disarm All does not revoke token approvals. An exited position can
            remain armed and exit later deposits. This control is available even
            when your balance is zero.
          </p>
        </div>
      </div>
      <label htmlFor="allowance-vault">Vault</label>
      <select
        id="allowance-vault"
        value={vault}
        onChange={(e) => setVault(e.target.value as Address)}
        disabled={busy}
      >
        {net.chain.vaults.map((v) => (
          <option value={v.address} key={v.address}>
            {v.name}
          </option>
        ))}
      </select>
      <p className="cd-caption">
        Allowance in share units:{" "}
        {mine ? (value ?? "Reading…") : "Connect the owner wallet to read it."}
      </p>
      <label className="cd-terms">
        <input
          type="checkbox"
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
          disabled={!mine || busy}
        />{" "}
        Stop automatic exits for this vault and revoke its approval. This can
        require two wallet confirmations.
      </label>
      <button
        className="cd-button cd-button-dark"
        disabled={
          !mine || busy || !accepted || value === null || value === "unreadable"
        }
        onClick={() =>
          act(async () => {
            try {
              await net.disarmAndRevoke(signer!, vault as Address);
              return {
                text: "This vault position is disarmed and its router allowance is zero.",
              };
            } finally {
              setRefresh((n) => n + 1);
              setAccepted(false);
            }
          })
        }
      >
        Disarm this vault and revoke
      </button>
    </section>
  );
}
