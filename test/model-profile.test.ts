import { describe, expect, test } from "vitest";
import {
  DEFAULT_ACTIVE_ALIAS,
  DEFAULT_OBSERVER_ALIAS,
  loadModelProfile,
  resolveAliasModelId,
  resolveModelCard,
  resolveObservationalMemoryThresholds,
  resolveProxyGatewayModelId,
  selectModelAlias,
} from "@rlabs/runtime-config";

describe("model profile", () => {
  test("loads the stable A1 proxy catalog and role defaults", () => {
    const profile = loadModelProfile();

    expect(profile.provider.id).toBe("a1-proxy");
    expect(profile.aliases).toEqual([
      "primary",
      "gpt-4o",
      "secondary",
      "third",
      "code-frontier-max",
      "code-frontier-high",
      "code-frontier-low",
      "code-workhorse-high",
      "code-workhorse-low",
      "code-economic",
      "fast",
      "fast-high",
      "fast-low",
    ]);
    expect(profile.roles).toMatchObject({
      cortex: DEFAULT_ACTIVE_ALIAS,
      flux: DEFAULT_ACTIVE_ALIAS,
      zen: DEFAULT_ACTIVE_ALIAS,
      // Orchestration-heavy: Ayra provisions domain-focused agents and authors
      // dynamic workflows, so it stays on the frontier tier.
      ayra: DEFAULT_ACTIVE_ALIAS,
      specialist: DEFAULT_ACTIVE_ALIAS,
      observer: DEFAULT_OBSERVER_ALIAS,
      reflector: DEFAULT_OBSERVER_ALIAS,
    });
    // Profile-level fallback only. Every alias above declares a card, so this
    // budget applies to a custom alias that does not.
    expect(profile.memory).toEqual({
      contextBudgetTokens: 120_000,
      observationThresholdTokens: 60_000,
    });
  });

  test("declares a preset card for every catalog alias", () => {
    const profile = loadModelProfile();

    expect(Object.keys(profile.modelCards).sort()).toEqual([...profile.aliases].sort());
    for (const alias of profile.aliases) {
      const card = resolveModelCard(profile, alias);
      expect(card.capabilities.length, alias).toBeGreaterThan(0);
      expect(card.observation.messageTokens, alias).toBeLessThanOrEqual(card.contextWindowTokens);
      expect(card.reflection.observationTokens, alias).toBeLessThanOrEqual(card.observation.messageTokens);
    }
  });

  test("resolves the canonical observational-memory budgets from the default agent's card", () => {
    const profile = loadModelProfile();
    const card = resolveModelCard(profile, profile.roles[profile.code.defaultAgent]);

    // Only messageTokens reaches upstream; bufferTokens and bufferActivation are
    // declared intent for an upstream extension point that does not exist yet.
    expect(card.observation.messageTokens).toBe(180_000);
    expect(card.observation.bufferTokens).toBe(30_000);
    expect(card.observation.bufferActivation).toBe(0.8);
    expect(card.reflection.observationTokens).toBe(60_000);
    expect(resolveObservationalMemoryThresholds(profile)).toEqual({
      observationThreshold: 180_000,
      reflectionThreshold: 60_000,
    });
  });

  test("selects a catalog model by capability rather than by alias name", () => {
    const profile = loadModelProfile();

    expect(selectModelAlias(profile, { capabilities: ["long-context"] })).toBe("code-frontier-max");
    expect(selectModelAlias(profile, { capabilities: ["vision"] })).toBe("gpt-4o");
    expect(profile.aliases).toContain(selectModelAlias(profile, { capabilities: ["economical"] }));
  });

  test("resolves only catalog aliases and rejects raw upstream IDs", () => {
    const profile = loadModelProfile();

    expect(resolveAliasModelId(profile, "code-frontier-high")).toBe("a1-proxy/code-frontier-high");
    expect(resolveProxyGatewayModelId(profile, "code-frontier-high")).toBe("proxy/a1-proxy/code-frontier-high");
    expect(() => resolveAliasModelId(profile, "gpt-5.6-sol")).toThrow(/unknown model alias/i);
    expect(() => resolveAliasModelId(profile, "openai\/gpt-5.6-sol")).toThrow(/unknown model alias/i);
  });
});
