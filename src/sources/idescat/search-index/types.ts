export interface IdescatSearchIndexEntry {
  ancestor_labels: {
    node: string;
    statistic: string;
  };
  geo_ids?: string[];
  label: string;
  node_id: string;
  source_url: string;
  statistics_id: string;
  table_id: string;
}
