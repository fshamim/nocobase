import type { CollectionOptions } from '@nocobase/client';

export const ecobaseClientCollections: CollectionOptions[] = [
  {
    "name": "ecobaseSourceConnections",
    "title": "Ecobase Source Connections",
    "filterTargetKey": "id",
    "fields": [
      {
        "name": "id",
        "type": "uuid",
        "interface": "uuid",
        "primaryKey": true,
        "uiSchema": {
          "type": "string",
          "title": "Id",
          "x-component": "Input"
        }
      },
      {
        "name": "name",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Name",
          "x-component": "Input"
        }
      },
      {
        "name": "sourceType",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source Type",
          "x-component": "Input"
        }
      },
      {
        "name": "domain",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Domain",
          "x-component": "Input"
        }
      },
      {
        "name": "config",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Config",
          "x-component": "Input"
        }
      },
      {
        "name": "secretRef",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Secret Ref",
          "x-component": "Input"
        }
      },
      {
        "name": "freshnessSlaMinutes",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Freshness Sla Minutes",
          "x-component": "Input"
        }
      },
      {
        "name": "active",
        "type": "boolean",
        "interface": "checkbox",
        "uiSchema": {
          "type": "boolean",
          "title": "Active",
          "x-component": "Checkbox"
        }
      }
    ]
  },
  {
    "name": "ecobaseImportRuns",
    "title": "Ecobase Import Runs",
    "filterTargetKey": "id",
    "fields": [
      {
        "name": "id",
        "type": "uuid",
        "interface": "uuid",
        "primaryKey": true,
        "uiSchema": {
          "type": "string",
          "title": "Id",
          "x-component": "Input"
        }
      },
      {
        "name": "adapterName",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Adapter Name",
          "x-component": "Input"
        }
      },
      {
        "name": "sourceIdentifier",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source Identifier",
          "x-component": "Input"
        }
      },
      {
        "name": "sourceVersion",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source Version",
          "x-component": "Input"
        }
      },
      {
        "name": "idempotencyKey",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Idempotency Key",
          "x-component": "Input"
        }
      },
      {
        "name": "startedAt",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Started At",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "finishedAt",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Finished At",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "status",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Status",
          "x-component": "Input"
        }
      },
      {
        "name": "rowCount",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Row Count",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "normalizedCount",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Normalized Count",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "warningCount",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Warning Count",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "errorCount",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Error Count",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "errorMessage",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Error Message",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "summary",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Summary",
          "x-component": "Input.TextArea"
        }
      }
    ]
  },
  {
    "name": "ecobaseRawImportRows",
    "title": "Ecobase Raw Import Rows",
    "filterTargetKey": "id",
    "fields": [
      {
        "name": "id",
        "type": "uuid",
        "interface": "uuid",
        "primaryKey": true,
        "uiSchema": {
          "type": "string",
          "title": "Id",
          "x-component": "Input"
        }
      },
      {
        "name": "rowNumber",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Row Number",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "sourceKey",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source Key",
          "x-component": "Input"
        }
      },
      {
        "name": "payload",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Payload",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "normalizedStatus",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Normalized Status",
          "x-component": "Input"
        }
      },
      {
        "name": "normalizedError",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Normalized Error",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "issueSeverity",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Issue Severity",
          "x-component": "Input"
        }
      },
      {
        "name": "issueCode",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Issue Code",
          "x-component": "Input"
        }
      }
    ]
  },
  {
    "name": "ecobaseRawListings",
    "title": "Ecobase Raw Listings",
    "filterTargetKey": "id",
    "fields": [
      {
        "name": "id",
        "type": "uuid",
        "interface": "uuid",
        "primaryKey": true,
        "uiSchema": {
          "type": "string",
          "title": "Id",
          "x-component": "Input"
        }
      },
      {
        "name": "naturalKey",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Natural Key",
          "x-component": "Input"
        }
      },
      {
        "name": "sourceConnectionId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source Connection Id",
          "x-component": "Input"
        }
      },
      {
        "name": "asin",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Asin",
          "x-component": "Input"
        }
      },
      {
        "name": "sku",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Sku",
          "x-component": "Input"
        }
      },
      {
        "name": "title",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Title",
          "x-component": "Input"
        }
      },
      {
        "name": "company",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Company",
          "x-component": "Input"
        }
      },
      {
        "name": "brand",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Brand",
          "x-component": "Input"
        }
      },
      {
        "name": "supplier",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Supplier",
          "x-component": "Input"
        }
      },
      {
        "name": "marketplace",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Marketplace",
          "x-component": "Input"
        }
      },
      {
        "name": "payload",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Payload",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "lastImportRunId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Last Import Run Id",
          "x-component": "Input"
        }
      }
    ]
  },
  {
    "name": "ecobaseListingDailyFacts",
    "title": "Ecobase Listing Daily Facts",
    "filterTargetKey": "id",
    "fields": [
      {
        "name": "id",
        "type": "uuid",
        "interface": "uuid",
        "primaryKey": true,
        "uiSchema": {
          "type": "string",
          "title": "Id",
          "x-component": "Input"
        }
      },
      {
        "name": "naturalKey",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Natural Key",
          "x-component": "Input"
        }
      },
      {
        "name": "sourceConnectionId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source Connection Id",
          "x-component": "Input"
        }
      },
      {
        "name": "planningProductId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Planning Product Id",
          "x-component": "Input"
        }
      },
      {
        "name": "snapshotDate",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Snapshot Date",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "company",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Company",
          "x-component": "Input"
        }
      },
      {
        "name": "asin",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Asin",
          "x-component": "Input"
        }
      },
      {
        "name": "sku",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Sku",
          "x-component": "Input"
        }
      },
      {
        "name": "sales",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Sales",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "units",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Units",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "refunds",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Refunds",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "refundRate",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Refund Rate",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "grossProfit",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Gross Profit",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "netProfit",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Net Profit",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "margin",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Margin",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "sessions",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Sessions",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "unitSessionPercentage",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Unit Session Percentage",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "sourceKey",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source Key",
          "x-component": "Input"
        }
      },
      {
        "name": "payload",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Payload",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "lastImportRunId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Last Import Run Id",
          "x-component": "Input"
        }
      }
    ]
  },
  {
    "name": "ecobasePlanningProducts",
    "title": "Ecobase Planning Products",
    "filterTargetKey": "id",
    "fields": [
      {
        "name": "id",
        "type": "uuid",
        "interface": "uuid",
        "primaryKey": true,
        "uiSchema": {
          "type": "string",
          "title": "Id",
          "x-component": "Input"
        }
      },
      {
        "name": "naturalKey",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Natural Key",
          "x-component": "Input"
        }
      },
      {
        "name": "company",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Company",
          "x-component": "Input"
        }
      },
      {
        "name": "canonicalAsin",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Canonical Asin",
          "x-component": "Input"
        }
      },
      {
        "name": "title",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Title",
          "x-component": "Input"
        }
      },
      {
        "name": "mappingStatus",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Mapping Status",
          "x-component": "Input"
        }
      },
      {
        "name": "listingCount",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Listing Count",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "lastImportRunId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Last Import Run Id",
          "x-component": "Input"
        }
      },
      {
        "name": "confirmedAt",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Confirmed At",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "confirmedBy",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Confirmed By",
          "x-component": "Input"
        }
      },
      {
        "name": "auditSummary",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Audit Summary",
          "x-component": "Input.TextArea"
        }
      }
    ]
  },
  {
    "name": "ecobaseInventorySnapshots",
    "title": "Ecobase Inventory Snapshots",
    "filterTargetKey": "id",
    "fields": [
      {
        "name": "id",
        "type": "uuid",
        "interface": "uuid",
        "primaryKey": true,
        "uiSchema": {
          "type": "string",
          "title": "Id",
          "x-component": "Input"
        }
      },
      {
        "name": "naturalKey",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Natural Key",
          "x-component": "Input"
        }
      },
      {
        "name": "sourceConnectionId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source Connection Id",
          "x-component": "Input"
        }
      },
      {
        "name": "planningProductId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Planning Product Id",
          "x-component": "Input"
        }
      },
      {
        "name": "snapshotDate",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Snapshot Date",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "company",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Company",
          "x-component": "Input"
        }
      },
      {
        "name": "asin",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Asin",
          "x-component": "Input"
        }
      },
      {
        "name": "sku",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Sku",
          "x-component": "Input"
        }
      },
      {
        "name": "stock",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Stock",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "reserved",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Reserved",
          "x-component": "Input"
        }
      },
      {
        "name": "inbound",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Inbound",
          "x-component": "Input"
        }
      },
      {
        "name": "ordered",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Ordered",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "prepStock",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Prep Stock",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "salesVelocity",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Sales Velocity",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "daysOfStockLeft",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Days Of Stock Left",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "recommendedReorderQuantity",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Recommended Reorder Quantity",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "payload",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Payload",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "lastImportRunId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Last Import Run Id",
          "x-component": "Input"
        }
      }
    ]
  },
  {
    "name": "ecobasePlanningCalculationSnapshots",
    "title": "Ecobase Planning Calculation Snapshots",
    "filterTargetKey": "id",
    "fields": [
      {
        "name": "id",
        "type": "uuid",
        "interface": "uuid",
        "primaryKey": true,
        "uiSchema": {
          "type": "string",
          "title": "Id",
          "x-component": "Input"
        }
      },
      {
        "name": "naturalKey",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Natural Key",
          "x-component": "Input"
        }
      },
      {
        "name": "planningProductId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Planning Product Id",
          "x-component": "Input"
        }
      },
      {
        "name": "calculationDate",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Calculation Date",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "ruleVersion",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Rule Version",
          "x-component": "Input"
        }
      },
      {
        "name": "company",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Company",
          "x-component": "Input"
        }
      },
      {
        "name": "canonicalAsin",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Canonical Asin",
          "x-component": "Input"
        }
      },
      {
        "name": "tier",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Tier",
          "x-component": "Input"
        }
      },
      {
        "name": "tierScore",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Tier Score",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "currentStockParity",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Current Stock Parity",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "sellableStock",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Sellable Stock",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "pipelineStock",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Pipeline Stock",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "salesVelocity",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Sales Velocity",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "daysOfCover",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Days Of Cover",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "oosDate",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Oos Date",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "leadTimeDays",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Lead Time Days",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "safetyBufferDays",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Safety Buffer Days",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "restockDeadlineParity",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Restock Deadline Parity",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "restockDeadlineImproved",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Restock Deadline Improved",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "latestSafeReorderWindowStart",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Latest Safe Reorder Window Start",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "latestSafeReorderWindowEnd",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Latest Safe Reorder Window End",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "daysLeftOrOverdue",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Days Left Or Overdue",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "urgentRestock",
        "type": "boolean",
        "interface": "checkbox",
        "uiSchema": {
          "type": "boolean",
          "title": "Urgent Restock",
          "x-component": "Checkbox"
        }
      },
      {
        "name": "restockNeeded",
        "type": "boolean",
        "interface": "checkbox",
        "uiSchema": {
          "type": "boolean",
          "title": "Restock Needed",
          "x-component": "Checkbox"
        }
      },
      {
        "name": "estimatedMonthEndQuantity",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Estimated Month End Quantity",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "recommendedBestQty",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Recommended Best Qty",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "profitPerUnit",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Profit Per Unit",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "achievedProfitMtd",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Achieved Profit Mtd",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "proratedProfitTargetMtd",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Prorated Profit Target Mtd",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "profitGap",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Profit Gap",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "profitOffTrack",
        "type": "boolean",
        "interface": "checkbox",
        "uiSchema": {
          "type": "boolean",
          "title": "Profit Off Track",
          "x-component": "Checkbox"
        }
      },
      {
        "name": "estimatedProfitRisk",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Estimated Profit Risk",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "dataCompleteness",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Data Completeness",
          "x-component": "Input"
        }
      },
      {
        "name": "calculationStatus",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Calculation Status",
          "x-component": "Input"
        }
      },
      {
        "name": "evidence",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Evidence",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "lastImportRunId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Last Import Run Id",
          "x-component": "Input"
        }
      }
    ]
  },
  {
    "name": "ecobaseAlerts",
    "title": "Ecobase Alerts",
    "filterTargetKey": "id",
    "fields": [
      {
        "name": "id",
        "type": "uuid",
        "interface": "uuid",
        "primaryKey": true,
        "uiSchema": {
          "type": "string",
          "title": "Id",
          "x-component": "Input"
        }
      },
      {
        "name": "dedupeKey",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Dedupe Key",
          "x-component": "Input"
        }
      },
      {
        "name": "planningProductId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Planning Product Id",
          "x-component": "Input"
        }
      },
      {
        "name": "company",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Company",
          "x-component": "Input"
        }
      },
      {
        "name": "canonicalAsin",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Canonical Asin",
          "x-component": "Input"
        }
      },
      {
        "name": "title",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Title",
          "x-component": "Input"
        }
      },
      {
        "name": "alertEvaluationId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Alert Evaluation Id",
          "x-component": "Input"
        }
      },
      {
        "name": "alertType",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Alert Type",
          "x-component": "Input"
        }
      },
      {
        "name": "severity",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Severity",
          "x-component": "Input"
        }
      },
      {
        "name": "status",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Status",
          "x-component": "Input"
        }
      },
      {
        "name": "subjectRef",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Subject Ref",
          "x-component": "Input"
        }
      },
      {
        "name": "primaryRootCauseCode",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Primary Root Cause Code",
          "x-component": "Input"
        }
      },
      {
        "name": "actionRequired",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Action Required",
          "x-component": "Input"
        }
      },
      {
        "name": "rootCauses",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Root Causes",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "dataWarnings",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Data Warnings",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "evidence",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Evidence",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "openedAt",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Opened At",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "lastSeenAt",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Last Seen At",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "resolvedAt",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Resolved At",
          "x-component": "DatePicker"
        }
      }
    ]
  },
  {
    "name": "ecobaseSupplierOrders",
    "title": "Ecobase Supplier Orders",
    "filterTargetKey": "id",
    "fields": [
      {
        "name": "id",
        "type": "uuid",
        "interface": "uuid",
        "primaryKey": true,
        "uiSchema": {
          "type": "string",
          "title": "Id",
          "x-component": "Input"
        }
      },
      {
        "name": "naturalKey",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Natural Key",
          "x-component": "Input"
        }
      },
      {
        "name": "sourceConnectionId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source Connection Id",
          "x-component": "Input"
        }
      },
      {
        "name": "company",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Company",
          "x-component": "Input"
        }
      },
      {
        "name": "supplierId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Supplier Id",
          "x-component": "Input"
        }
      },
      {
        "name": "externalOrderRef",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "External Order Ref",
          "x-component": "Input"
        }
      },
      {
        "name": "sourceStage",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source Stage",
          "x-component": "Input"
        }
      },
      {
        "name": "status",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Status",
          "x-component": "Input"
        }
      },
      {
        "name": "statusSource",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Status Source",
          "x-component": "Input"
        }
      },
      {
        "name": "statusUpdatedAt",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Status Updated At",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "lastMeaningfulUpdateAt",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Last Meaningful Update At",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "lastOperatorEditAt",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Last Operator Edit At",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "lastOperatorActor",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Last Operator Actor",
          "x-component": "Input"
        }
      },
      {
        "name": "orderDate",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Order Date",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "expectedDeliveryDate",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Expected Delivery Date",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "expectedDeliveryDateSource",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Expected Delivery Date Source",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "approvalStatus",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Approval Status",
          "x-component": "Input"
        }
      },
      {
        "name": "paymentStatus",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Payment Status",
          "x-component": "Input"
        }
      },
      {
        "name": "shippingCarrier",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Shipping Carrier",
          "x-component": "Input"
        }
      },
      {
        "name": "trackingId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Tracking Id",
          "x-component": "Input"
        }
      },
      {
        "name": "blockedReason",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Blocked Reason",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "payload",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Payload",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "lastImportRunId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Last Import Run Id",
          "x-component": "Input"
        }
      }
    ]
  },
  {
    "name": "ecobaseSupplierOrderLines",
    "title": "Ecobase Supplier Order Lines",
    "filterTargetKey": "id",
    "fields": [
      {
        "name": "id",
        "type": "uuid",
        "interface": "uuid",
        "primaryKey": true,
        "uiSchema": {
          "type": "string",
          "title": "Id",
          "x-component": "Input"
        }
      },
      {
        "name": "naturalKey",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Natural Key",
          "x-component": "Input"
        }
      },
      {
        "name": "supplierOrderId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Supplier Order Id",
          "x-component": "Input"
        }
      },
      {
        "name": "company",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Company",
          "x-component": "Input"
        }
      },
      {
        "name": "supplierId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Supplier Id",
          "x-component": "Input"
        }
      },
      {
        "name": "planningProductId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Planning Product Id",
          "x-component": "Input"
        }
      },
      {
        "name": "asin",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Asin",
          "x-component": "Input"
        }
      },
      {
        "name": "sku",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Sku",
          "x-component": "Input"
        }
      },
      {
        "name": "brand",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Brand",
          "x-component": "Input"
        }
      },
      {
        "name": "orderedQty",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Ordered Qty",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "receivedQty",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Received Qty",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "receivedQtySource",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Received Qty Source",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "expectedDeliveryDate",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Expected Delivery Date",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "expectedSellableDate",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Expected Sellable Date",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "expectedSellableDateSource",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Expected Sellable Date Source",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "expectedSellableDateEvidence",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Expected Sellable Date Evidence",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "expectedSellableDateDerivedAt",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Expected Sellable Date Derived At",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "lastOperatorEditAt",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Last Operator Edit At",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "lastOperatorActor",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Last Operator Actor",
          "x-component": "Input"
        }
      },
      {
        "name": "unitCost",
        "type": "double",
        "interface": "number",
        "uiSchema": {
          "type": "number",
          "title": "Unit Cost",
          "x-component": "InputNumber"
        }
      },
      {
        "name": "sourceOrderLineRef",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source Order Line Ref",
          "x-component": "Input"
        }
      },
      {
        "name": "sourceStage",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source Stage",
          "x-component": "Input"
        }
      },
      {
        "name": "observedAt",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Observed At",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "unresolvedMapping",
        "type": "boolean",
        "interface": "checkbox",
        "uiSchema": {
          "type": "boolean",
          "title": "Unresolved Mapping",
          "x-component": "Checkbox"
        }
      },
      {
        "name": "mappingWarning",
        "type": "boolean",
        "interface": "checkbox",
        "uiSchema": {
          "type": "boolean",
          "title": "Mapping Warning",
          "x-component": "Checkbox"
        }
      },
      {
        "name": "payload",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Payload",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "lastImportRunId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Last Import Run Id",
          "x-component": "Input"
        }
      }
    ]
  },
  {
    "name": "ecobaseSupplierLeadTimes",
    "title": "Ecobase Supplier Lead Times",
    "filterTargetKey": "id",
    "fields": [
      {
        "name": "id",
        "type": "uuid",
        "interface": "uuid",
        "primaryKey": true,
        "uiSchema": {
          "type": "string",
          "title": "Id",
          "x-component": "Input"
        }
      },
      {
        "name": "naturalKey",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Natural Key",
          "x-component": "Input"
        }
      },
      {
        "name": "sourceConnectionId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source Connection Id",
          "x-component": "Input"
        }
      },
      {
        "name": "supplierId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Supplier Id",
          "x-component": "Input"
        }
      },
      {
        "name": "supplierRefId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Supplier Ref Id",
          "x-component": "Input"
        }
      },
      {
        "name": "supplierName",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Supplier Name",
          "x-component": "Input"
        }
      },
      {
        "name": "company",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Company",
          "x-component": "Input"
        }
      },
      {
        "name": "leadTimeDays",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Lead Time Days",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "confirmedAt",
        "type": "datetimeTz",
        "interface": "datetime",
        "uiSchema": {
          "type": "datetime",
          "title": "Confirmed At",
          "x-component": "DatePicker"
        }
      },
      {
        "name": "source",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Source",
          "x-component": "Input"
        }
      },
      {
        "name": "notes",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Notes",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "payload",
        "type": "text",
        "interface": "textarea",
        "uiSchema": {
          "type": "string",
          "title": "Payload",
          "x-component": "Input.TextArea"
        }
      },
      {
        "name": "lastImportRunId",
        "type": "string",
        "interface": "input",
        "uiSchema": {
          "type": "string",
          "title": "Last Import Run Id",
          "x-component": "Input"
        }
      }
    ]
  }
];
