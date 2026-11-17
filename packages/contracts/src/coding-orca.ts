/** Orca operations with local side effects. Approval binds to the exact step arguments. */
export const ORCA_MUTATING_TOOLS = [
  'coding.orca.create',
  'coding.orca.register',
  'coding.orca.launch',
  'coding.orca.resume',
] as const;

export function isOrcaMutation(toolId: string): boolean {
  return (ORCA_MUTATING_TOOLS as readonly string[]).includes(toolId);
}
