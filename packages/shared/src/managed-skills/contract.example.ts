import { verifyManagedSkillBundle, type ManagedSkillTrust } from "./index.js";

export function loadAuthenticatedSkill(
  envelope: unknown,
  deploymentTrust: ManagedSkillTrust,
): string {
  const bundle = verifyManagedSkillBundle(envelope, deploymentTrust);
  const entry = bundle.files.find((file) => file.path === "SKILL.md")!;
  return new TextDecoder().decode(entry.bytes);
}
