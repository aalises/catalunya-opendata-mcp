import type { IdescatSearchIndexEntry } from "./types.js";

const entries: IdescatSearchIndexEntry[] = [
  {
    statistics_id: "pmh",
    node_id: "1180",
    table_id: "8078",
    label: "Poblacio a 1 de gener. Per sexe i edat any a any (2014-)",
    ancestor_labels: {
      statistic: "Padro municipal d'habitants",
      node: "Poblacio a 1 de gener. Per sexe i edat any a any",
    },
    source_url: "https://api.idescat.cat/taules/v2/pmh/1180/8078?lang=ca",
  },
  {
    statistics_id: "pmh",
    node_id: "446",
    table_id: "477",
    label: "Poblacio a 1 de gener. Per sexe",
    ancestor_labels: {
      statistic: "Padro municipal d'habitants",
      node: "Poblacio a 1 de gener. Per sexe",
    },
    source_url: "https://api.idescat.cat/taules/v2/pmh/446/477?lang=ca",
  },
];

export default entries;
export const generatedAt = "2026-04-26T00:00:00.000Z";
export const indexVersion = "manual-2026-04-26";
export const sourceCollectionUrls = ["https://api.idescat.cat/taules/v2?lang=ca"];
