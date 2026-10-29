/** Operator-owned restriction, never an agent-editable adapter setting.
 * Observers use a separate capability broker for data and user-approved work.
 * The HTTP guard also covers the sandbox callback tunnel and run JWTs.
 */
export function isObserverAgent(agentId: string | null | undefined): boolean {
  return Boolean(agentId && (process.env.PAPERCLIP_OBSERVER_AGENT_IDS ?? "")
    .split(",").map((id) => id.trim()).filter(Boolean).includes(agentId));
}
