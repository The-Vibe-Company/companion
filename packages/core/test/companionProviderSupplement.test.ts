import { describe, expect, it, vi } from "vitest";
import {
  CompanionProviderCatalogCache,
  companionCatalogModel,
  getCompanionProviderCatalog,
} from "../src/companionProviderCatalog";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function providerIdFromRequest(input: string | URL | Request): string {
  return decodeURIComponent(new URL(new Request(input).url).pathname.split("/").at(-1) ?? "");
}

function jsonResponse(value: JsonValue, status = 200): Response {
  return Response.json(value, { status });
}

function ordinaryProviderResponse(input: string | URL | Request): Response {
  const providerId = providerIdFromRequest(input);
  const id = `${providerId}-live`;
  return jsonResponse({ [id]: { id, name: `${providerId} live` } });
}

describe("Companion provider catalog supplements", () => {
  it("adds GLM 5.3 Flash to a successful Pi catalog and API validation", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (providerIdFromRequest(input) !== "zai") return ordinaryProviderResponse(input);
      return jsonResponse({
        "glm-5.3": { id: "glm-5.3", name: "GLM-5.3", input: ["text"] },
      });
    });

    const catalog = await getCompanionProviderCatalog({
      fetchImpl,
      cache: new CompanionProviderCatalogCache(),
    });
    const flash = catalog.find((provider) => provider.id === "zai")?.models
      .find((model) => model.id === "glm-5.3-flash");

    expect(flash).toEqual({
      id: "glm-5.3-flash",
      name: "GLM 5.3 Flash",
      input: ["text", "image"],
    });
    expect(companionCatalogModel(catalog, "zai", "glm-5.3-flash"))
      .toBe("glm-5.3-flash");
  });

  it("keeps GLM 5.3 Flash in the cold-start outage fallback", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}, 503));

    const catalog = await getCompanionProviderCatalog({
      fetchImpl,
      cache: new CompanionProviderCatalogCache(),
    });

    expect(catalog.find((provider) => provider.id === "zai")?.models)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "glm-5.3-flash",
          name: "GLM 5.3 Flash",
          input: ["text", "image"],
        }),
      ]));
  });

  it("lets Pi replace provisional metadata without changing the pinned executable set", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (providerIdFromRequest(input) !== "zai") return ordinaryProviderResponse(input);
      return jsonResponse({
        "glm-5.3-flash": {
          id: "glm-5.3-flash",
          name: "Pi GLM-5.3-Flash",
          input: ["text", "image"],
        },
      });
    });

    const catalog = await getCompanionProviderCatalog({
      fetchImpl,
      cache: new CompanionProviderCatalogCache(),
    });

    expect(catalog.find((provider) => provider.id === "zai")?.models).toEqual(
      expect.arrayContaining([
        {
          id: "glm-5.3-flash",
          name: "Pi GLM-5.3-Flash",
          input: ["text", "image"],
        },
        expect.objectContaining({ id: "glm-4.7", default: true }),
      ]),
    );
  });
});
