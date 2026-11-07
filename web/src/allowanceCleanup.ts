/** Owner-approved, sequential cleanup. A rejected revoke must not be reported as completed. */
export async function cleanupAllowance(io: {
  armed: () => Promise<boolean>;
  disarm: () => Promise<unknown>;
  allowance: () => Promise<bigint>;
  revoke: () => Promise<unknown>;
}) {
  let disarmed = false;
  if (await io.armed()) {
    await io.disarm();
    disarmed = true;
  }
  try {
    if ((await io.allowance()) !== 0n) await io.revoke();
    if ((await io.allowance()) !== 0n)
      throw new Error("Allowance is still nonzero");
  } catch {
    throw new Error(
      disarmed
        ? "This position was disarmed, but its allowance was not confirmed revoked. Retry the revoke in Plan and controls."
        : "The allowance was not confirmed revoked. Check the wallet and try again.",
    );
  }
  return { disarmed, revoked: true as const };
}
