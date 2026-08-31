import { workflow, node, trigger, sticky } from '@n8n/workflow-sdk';

const startReset = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Run Reset', position: [-400, 0] },
  output: [{}]
});

const dumpLines = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Dump Lines',
    position: [-180, 0],
    executeOnce: true,
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: '__LINES_TABLE_ID__', cachedResultName: 'csp_subscription_lines' },
      matchType: 'allConditions',
      filters: { conditions: [] },
      returnAll: true
    }
  },
  output: [{ id: 1, tenant_name: 'KANTANNA PTY LTD', subscription_id: '2F295B21', sync_status: 'synced' }]
});

const clearLines = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Clear Lines',
    position: [40, 0],
    executeOnce: true,
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'deleteRows',
      dataTableId: { __rl: true, mode: 'id', value: '__LINES_TABLE_ID__', cachedResultName: 'csp_subscription_lines' },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'id', condition: 'gte', keyValue: '0' }] },
      options: {}
    }
  },
  output: [{ id: 1 }]
});

const dumpMappings = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Dump Mappings',
    position: [260, 0],
    executeOnce: true,
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: '__MAPPINGS_TABLE_ID__', cachedResultName: 'csp_customer_mappings' },
      matchType: 'allConditions',
      filters: { conditions: [] },
      returnAll: true
    }
  },
  output: [{ id: 1, tenant_name: 'KANTANNA PTY LTD', autotask_company_id: 123, autotask_company_name: 'Kantanna Pty Ltd' }]
});

const clearMappings = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Clear Mappings',
    position: [480, 0],
    executeOnce: true,
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'deleteRows',
      dataTableId: { __rl: true, mode: 'id', value: '__MAPPINGS_TABLE_ID__', cachedResultName: 'csp_customer_mappings' },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'id', condition: 'gte', keyValue: '0' }] },
      options: {}
    }
  },
  output: [{ id: 1 }]
});

const dumpServices = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Dump SKU Services',
    position: [700, 0],
    executeOnce: true,
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: '__SERVICES_TABLE_ID__', cachedResultName: 'csp_sku_services' },
      matchType: 'allConditions',
      filters: { conditions: [] },
      returnAll: true
    }
  },
  output: [{ id: 1, sku: 'ANN-MO:CFQ7TTC0LCHC:0002', service_name: 'MS NCE M365 BUSINESS PREMIUM', autotask_service_id: 456, unit_rrp: 34.55 }]
});

const clearServices = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Clear SKU Services',
    position: [920, 0],
    executeOnce: true,
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'deleteRows',
      dataTableId: { __rl: true, mode: 'id', value: '__SERVICES_TABLE_ID__', cachedResultName: 'csp_sku_services' },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'id', condition: 'gte', keyValue: '0' }] },
      options: {}
    }
  },
  output: [{ id: 1 }]
});

// csp_report_rows is the verbatim snapshot of the uploaded workbooks, rebuilt
// from scratch by every import (workflow 01 clears it first). No dump: the
// backup is the .xlsx file itself, and the rows run to thousands.
const clearReportRows = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Clear Report Rows',
    position: [1140, 0],
    executeOnce: true,
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'deleteRows',
      dataTableId: { __rl: true, mode: 'id', value: '__REPORT_TABLE_ID__', cachedResultName: 'csp_report_rows' },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'id', condition: 'gte', keyValue: '0' }] },
      options: {}
    }
  },
  output: [{ id: 1 }]
});

const note = sticky(
  '## Reset the CSP data tables\n\nRun this by hand between test rounds. Each table is dumped to the execution log first (that dump IS the backup - open this execution to read the rows back), then every row is deleted.\n\nEmpties `csp_subscription_lines`, `csp_customer_mappings`, `csp_sku_services` and `csp_report_rows` (the raw upload snapshot - not dumped, the .xlsx you uploaded is its backup). Nothing in Autotask is touched: remove the External Contract Number from any test contract there yourself, or the next sync will adopt it again.',
  [startReset, dumpLines, clearLines, dumpMappings, clearMappings, dumpServices, clearServices, clearReportRows],
  { color: 3 }
);

export default workflow('zz-reset-data-tables', 'ZZ · Reset CSP Data Tables')
  .add(startReset)
  .to(dumpLines)
  .to(clearLines)
  .to(dumpMappings)
  .to(clearMappings)
  .to(dumpServices)
  .to(clearServices)
  .to(clearReportRows)
  .add(note);
