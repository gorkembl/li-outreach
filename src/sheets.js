// sheets.js
// Google Sheets read/write. Auto-creates tabs and validation on first run.

import { google } from 'googleapis';
import { SHEET_TABS, SCHEMAS, STATUSES, TARGET_SIDES, ACTION_RESULTS, DIRECTIONS, CHANNELS } from './config.js';

let sheetsClient = null;
let SPREADSHEET_ID = null;

// ----- Auth -----
export async function initSheets() {
  SPREADSHEET_ID = process.env.SHEET_ID;
  if (!SPREADSHEET_ID) throw new Error('SHEET_ID env var missing');

  const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!credsJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var missing');

  const creds = JSON.parse(credsJson);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  console.log('[sheets] authenticated as', creds.client_email);
}

// ----- Schema initialization -----
export async function ensureSchema() {
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingSheets = meta.data.sheets.map(s => s.properties.title);
  const existingSheetIds = {};
  meta.data.sheets.forEach(s => { existingSheetIds[s.properties.title] = s.properties.sheetId; });

  const requests = [];
  const tabsToCreate = [];

  for (const tab of Object.values(SHEET_TABS)) {
    if (!existingSheets.includes(tab)) {
      tabsToCreate.push(tab);
      requests.push({
        addSheet: { properties: { title: tab } },
      });
    }
  }

  if (requests.length > 0) {
    console.log('[sheets] creating tabs:', tabsToCreate.join(', '));
    const res = await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
    // Capture new sheet IDs
    res.data.replies.forEach((r, i) => {
      existingSheetIds[tabsToCreate[i]] = r.addSheet.properties.sheetId;
    });

    // If Sheet1 still exists and is now redundant, leave it — user can delete manually
  }

  // Write headers for each tab (if missing)
  for (const [tab, schema] of Object.entries(SCHEMAS)) {
    const range = `${tab}!1:1`;
    const current = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });
    const hasHeaders = current.data.values && current.data.values[0] && current.data.values[0].length > 0;
    if (!hasHeaders) {
      console.log(`[sheets] writing headers for ${tab}`);
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range,
        valueInputOption: 'RAW',
        requestBody: { values: [schema] },
      });
    }
  }

  // Apply validations and formatting
  await applyValidations(existingSheetIds);
  await applyFormatting(existingSheetIds);

  console.log('[sheets] schema ready');
}

async function applyValidations(sheetIds) {
  const requests = [];

  // Helper: dropdown validation on column X of sheet Y, rows 2..1000
  const dropdown = (sheetId, colIndex, values) => ({
    setDataValidation: {
      range: {
        sheetId,
        startRowIndex: 1, // row 2
        endRowIndex: 1000,
        startColumnIndex: colIndex,
        endColumnIndex: colIndex + 1,
      },
      rule: {
        condition: {
          type: 'ONE_OF_LIST',
          values: values.map(v => ({ userEnteredValue: v })),
        },
        showCustomUi: true,
        strict: false, // allow custom values too, just warn
      },
    },
  });

  // Lists.target_side (col 2, 0-indexed)
  requests.push(dropdown(sheetIds.Lists, 2, TARGET_SIDES));

  // Leads.status (col 7)
  requests.push(dropdown(sheetIds.Leads, 7, STATUSES));

  // ActionLog.result (col 3)
  requests.push(dropdown(sheetIds.ActionLog, 3, ACTION_RESULTS));

  // Conversations.direction (col 2), channel (col 3)
  requests.push(dropdown(sheetIds.Conversations, 2, DIRECTIONS));
  requests.push(dropdown(sheetIds.Conversations, 3, CHANNELS));

  // Freeze header row on all tabs
  for (const [tab, id] of Object.entries(sheetIds)) {
    if (!Object.values(SHEET_TABS).includes(tab)) continue;
    requests.push({
      updateSheetProperties: {
        properties: { sheetId: id, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });
  }

  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests },
  });
}

async function applyFormatting(sheetIds) {
  const requests = [];

  // Bold header row on all data tabs
  for (const tab of Object.values(SHEET_TABS)) {
    if (!sheetIds[tab]) continue;
    requests.push({
      repeatCell: {
        range: {
          sheetId: sheetIds[tab],
          startRowIndex: 0,
          endRowIndex: 1,
        },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 0.93, green: 0.93, blue: 0.95 },
          },
        },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    });
  }

  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests },
  });
}

// ----- Read operations -----
export async function getAllLeads() {
  const range = `${SHEET_TABS.LEADS}!A2:R`;
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
  const rows = res.data.values || [];
  return rows.map((row, idx) => rowToObject(SCHEMAS.Leads, row, idx + 2));
}

export async function getAllLists() {
  const range = `${SHEET_TABS.LISTS}!A2:I`;
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
  const rows = res.data.values || [];
  return rows.map((row, idx) => rowToObject(SCHEMAS.Lists, row, idx + 2));
}

export async function getListById(listId) {
  const all = await getAllLists();
  return all.find(l => l.list_id === listId);
}

// ----- Write operations -----
export async function updateLead(lead) {
  // lead._row is the spreadsheet row number
  if (!lead._row) throw new Error('updateLead: missing _row');
  const rowValues = SCHEMAS.Leads.map(col => {
    const v = lead[col];
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
  const range = `${SHEET_TABS.LEADS}!A${lead._row}:R${lead._row}`;
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [rowValues] },
  });
}

export async function logAction(leadId, action, result, details = '') {
  const row = [
    new Date().toISOString(),
    leadId,
    action,
    result,
    typeof details === 'object' ? JSON.stringify(details) : String(details),
  ];
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TABS.ACTION_LOG}!A:E`,
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
}

export async function logConversation(leadId, direction, channel, messageText, needsReview = true) {
  const row = [
    new Date().toISOString(),
    leadId,
    direction,
    channel,
    messageText,
    String(needsReview),
  ];
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TABS.CONVERSATIONS}!A:F`,
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
}

// ----- Helpers -----
function rowToObject(schema, row, rowNumber) {
  const obj = { _row: rowNumber };
  schema.forEach((col, i) => {
    const val = row[i] !== undefined ? row[i] : '';
    // Try to parse JSON fields
    if (col === 'personalization_context' && val && val.startsWith('{')) {
      try { obj[col] = JSON.parse(val); } catch { obj[col] = val; }
    } else {
      obj[col] = val;
    }
  });
  return obj;
}
