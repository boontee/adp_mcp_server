---
name: adp-document-poll
description: Submit documents to IBM Automation Document Processing (ADP), periodically poll processing status until complete or failed, and automatically retrieve and format extracted Key-Value Pairs (KVPs), tables, and classification results.
---

# ADP Document Polling & Extraction Workflow

Follow these steps to submit a document to IBM Automation Document Processing (ADP), poll its asynchronous status until processing completes, and retrieve structured extraction results.

---

## Step 1: Ingest or Identify Document ID

- **Case A: Local File Provided**
  1. Submit the document using the MCP tool `adp_submit_document`:
     ```json
     {
       "file_path": "<absolute_or_relative_path_to_document>"
     }
     ```
  2. Extract the `document_id` (also known as `analyzerId`) from the response:
     - JSON path: `result[0].data.analyzerId` or `documentId`.

- **Case B: Existing Document ID Provided**
  - Use the user-provided `document_id` directly.

---

## Step 2: Poll Status Until Completion

Poll the status asynchronously using the MCP tool `adp_get_document_status`:

```json
{
  "document_id": "<document_id>"
}
```

### Polling Rules:
1. Check `statusDetails[0].status` and `statusDetails[0].progress`:
   - **`InProgress`**: Wait 3 to 5 seconds (using `execute_command` with `sleep 4` if needed), then call `adp_get_document_status` again.
   - **`Completed`**: Proceed immediately to **Step 3**.
   - **`Failed`**: Stop polling. Report the failure reason from `statusDetails[0].errorList` and the classification `ValidationResult`.
2. **Timeout Safety**: Set a maximum of 30 polling iterations (approx. 2 minutes). If the document remains `InProgress` after 30 attempts, inform the user with the current progress percentage and offer to resume polling.

---

## Step 3: Retrieve Extracted Results

Once status is `Completed`, call `adp_get_document_results`:

```json
{
  "document_id": "<document_id>"
}
```

---

## Step 4: Parse & Format Results

Extract and present the structured findings in clean markdown:

### 1. Classification Overview
- **Document Class**: `Classification.DocumentClass.Actual`
- **Class Match / Confidence**: `Classification.DocumentClass.ClassConfidence`%
- **Validation**: `Classification.DocumentClass.ValidationResult`
- **Matched Template**: `Classification.DocumentClass.template.Name` (if applicable)

### 2. Extracted Key-Value Pairs (KVPs)
Iterate through `pageList[].KVPTable` and display non-empty fields in a markdown table:

| Field / Key Class | Detected Key Label | Extracted Value | Confidence |
| :--- | :--- | :--- | :--- |
| `EmployerName` | `Company Name` | `...` | High (100%) |
| `EmployeeName` | `Employee Name` | `...` | High (100%) |
| `Salary` | `Net Pay` | `...` | High (100%) |

### 3. Multi-Row Tables (if present)
If `pageList[].TableList` contains data rows, render them as markdown tables.

---

## Step 5: Follow-Up Actions

Offer the user next steps:
- **Download Annotated PDF**: Offer `adp_get_document_pdf(document_id, output_path)`.
- **Cleanup / Delete**: Offer `adp_delete_document(document_id)` to release server resources.
