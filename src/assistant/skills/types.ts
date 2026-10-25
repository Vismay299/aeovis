export type SkillFrontmatter = {
  name: string;
  description: string;
  version: string;
  source: string;
  tools: string[];
  optionalTools: string[];
  requiresFlags: string[];
  internal: boolean;
};

export type SkillManifestEntry = SkillFrontmatter & {
  sha256: string;
  body: string;
  title: string;
};
