import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDomainAsCompetitor } from "./addCompetitor.ts";
import { AppError } from "../../shared/http/appError.ts";

describe("addCompetitor", () => {
  const brand = {
    brand_key: "brand_test",
    display_name: "Offcult",
    website: "https://offcult.in",
    website_host: "offcult.in",
    aliases: ["Offcult India"],
  };

  const user = { id: "user_123" };
  const mockAdmin = {} as any;

  it("calls applyContextUpdates and returns added true when domain is new", async () => {
    let appliedUpdates: any = null;
    let appliedAuthor: any = null;
    let appliedUserId: any = null;

    const result = await addDomainAsCompetitor(
      mockAdmin,
      brand,
      user,
      { domain: "bewakoof.com" },
      {
        declaredCompetitors: async () => [],
        applyContextUpdates: async (_admin, _brand, updates, author, actorUserId) => {
          appliedUpdates = updates;
          appliedAuthor = author;
          appliedUserId = actorUserId;
          return {} as any;
        },
      },
    );

    assert.equal(result.added, true);
    assert.deepEqual(result.competitor, {
      domain: "bewakoof.com",
      name: null,
    });
    assert.equal(appliedAuthor, "user");
    assert.equal(appliedUserId, "user_123");
    assert.deepEqual(appliedUpdates, [
      {
        addCompetitors: [
          {
            domain: "bewakoof.com",
            name: undefined,
          },
        ],
      },
    ]);
  });

  it("returns added false when domain was already declared", async () => {
    const result = await addDomainAsCompetitor(
      mockAdmin,
      brand,
      user,
      { domain: "https://www.bewakoof.com", name: "Bewakoof" },
      {
        declaredCompetitors: async () => [
          { domain: "bewakoof.com", name: "Bewakoof", notes: null },
        ],
        applyContextUpdates: async () => ({} as any),
      },
    );

    assert.equal(result.added, false);
    assert.deepEqual(result.competitor, {
      domain: "bewakoof.com",
      name: "Bewakoof",
    });
  });

  it("refuses own website and throws context_invalid (F14-AC-09)", async () => {
    await assert.rejects(
      async () => {
        await addDomainAsCompetitor(
          mockAdmin,
          brand,
          user,
          { domain: "offcult.in" },
          {
            declaredCompetitors: async () => [],
            applyContextUpdates: async () => {
              throw new AppError(
                400,
                "context_invalid",
                "updates[0] was rejected (nothing in this batch was applied): Your own website cannot be a competitor.",
              );
            },
          },
        );
      },
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.code, "context_invalid");
        assert.match(err.message, /Your own website cannot be a competitor/);
        return true;
      },
    );
  });

  it("passes through context_cap error from F07", async () => {
    await assert.rejects(
      async () => {
        await addDomainAsCompetitor(
          mockAdmin,
          brand,
          user,
          { domain: "comp101.com" },
          {
            declaredCompetitors: async () => [],
            applyContextUpdates: async () => {
              throw new AppError(
                400,
                "context_cap",
                "A workspace can track 100 competitors. Remove some first.",
              );
            },
          },
        );
      },
      (err: any) => {
        assert.equal(err.status, 400);
        assert.equal(err.code, "context_cap");
        assert.match(err.message, /100 competitors/);
        return true;
      },
    );
  });
});
