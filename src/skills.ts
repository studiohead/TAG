/**
 * skills.ts — Load and validate YAML skill definitions.
 */

import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { Decision, Skill, SkillRule } from "./types";
import { log } from "./logger";
import { CONFIG } from "./config";

function isValidDecision(value: unknown): value is Decision {
  return Object.values(Decision).includes(value as Decision);
}

function validateRule(raw: unknown, skillName: string): SkillRule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.id !== "string" || !r.id) {
    log.warn("Skipping rule with missing id", { skill: skillName });
    return null;
  }
  // YAML parses bare true/false as booleans — coerce to string
  const conditionRaw = r.condition;
  let condition: string;
  if (typeof conditionRaw === "string") {
    condition = conditionRaw;
  } else if (typeof conditionRaw === "boolean") {
    condition = String(conditionRaw);
  } else {
    log.warn("Skipping rule with missing condition", { skill: skillName, id: r.id });
    return null;
  }
  if (!condition) {
    log.warn("Skipping rule with empty condition", { skill: skillName, id: r.id });
    return null;
  }
  if (!isValidDecision(r.decision)) {
    log.warn("Skipping rule with invalid decision", { skill: skillName, id: r.id, decision: r.decision });
    return null;
  }

  const rule: SkillRule = {
    id: r.id,
    condition: condition,
    decision: r.decision,
    reason: typeof r.reason === "string" ? r.reason : "Policy rule matched",
  };
  if (typeof r.priority === "number") rule.priority = r.priority;
  return rule;
}

function parseSkill(raw: unknown, filename: string): Skill | null {
  if (typeof raw !== "object" || raw === null) return null;
  const doc = raw as Record<string, unknown>;

  if (typeof doc.name !== "string" || !doc.name) {
    log.warn("Skipping skill file with missing name", { file: filename });
    return null;
  }

  const skill: Skill = { name: doc.name };

  if (typeof doc.description === "string") skill.description = doc.description;

  if (Array.isArray(doc.rules)) {
    skill.rules = doc.rules
      .map((r) => validateRule(r, doc.name as string))
      .filter((r): r is SkillRule => r !== null);
  }

  return skill;
}

export function loadSkills(skillsDir: string = CONFIG.skillsDir): Skill[] {
  const skills: Skill[] = [];

  if (!fs.existsSync(skillsDir)) {
    log.warn("Skills directory not found", { skillsDir });
    return skills;
  }

  const files = fs.readdirSync(skillsDir).sort();
  for (const file of files) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    const fullPath = path.join(skillsDir, file);

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const raw = yaml.load(content);
      const skill = parseSkill(raw, file);
      if (skill) {
        skills.push(skill);
        log.debug("Loaded skill", { name: skill.name, file });
      }
    } catch (err) {
      log.error("Failed to load skill file", { file, error: String(err) });
    }
  }

  log.info("Skills loaded", { count: skills.length, dir: skillsDir });
  return skills;
}

export function flattenRules(skills: Skill[]): SkillRule[] {
  return skills.flatMap((s) => s.rules ?? []);
}

export function getSkillByName(name: string, skills: Skill[]): Skill | undefined {
  return skills.find((s) => s.name === name);
}
