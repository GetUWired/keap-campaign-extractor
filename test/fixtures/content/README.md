# Content source fixtures

Shapes captured from live Keap accounts on 2026-09-21 (see docs/spike-findings.md §18). Every value
that could identify a person or client has been replaced: staff names are `User N`, addresses are
`example.com`, message and note text is synthetic.

| File | Source |
|---|---|
| `email-template-*.json` | `GET /crm/rest/v2/emails/templates/{id}` — field names verbatim |
| `webforms-list.json` | `GET /crm/rest/v2/webforms` — field names verbatim |
| `sms-*.json` | `GET /app/automatedSmsFunnel/{marketingAutomatedSmsId}` — field names verbatim |
| `note-editor.html` | `GET /app/noteFunnel/edit?marketingNoteId={id}&mayPickUser=false` — markup verbatim, names scrubbed, title/body replaced |
| `http-request-empty.html` | `GET /app/httpRequestFunnel/requests/{id}` — verbatim (an unconfigured step) |
| `http-request-configured.html` | The empty capture with values filled in using the editor's own row template. **Synthetic**: no configured HTTP Request existed to capture, so the populated-row markup is an assumption the live check must confirm. |
