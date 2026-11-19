import { getPublicUrlInventory } from "../server/publicSite.mjs";

export default function sitemap() {
  const inventory = getPublicUrlInventory();
  return inventory.map((item) => ({
    url: item.url,
    lastModified: new Date(item.lastModified),
    changeFrequency: item.changeFrequency,
    priority: item.priority,
  }));
}
