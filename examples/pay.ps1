# Run from the project folder after configuring .env and starting the server.
# This sends a REAL payment prompt when the server uses live Selcom credentials.
$ErrorActionPreference = 'Stop'
$selcomEnvPath = Join-Path $PSScriptRoot '..\.env'
if (-not (Test-Path $selcomEnvPath)) { throw 'Run npm run setup and configure .env first.' }
$selcomAppKeyLine = Get-Content $selcomEnvPath | Where-Object { $_ -match '^APP_API_KEY=' } | Select-Object -First 1
if (-not $selcomAppKeyLine) { throw 'APP_API_KEY was not found in .env.' }
$selcomAppKey = ($selcomAppKeyLine -replace '^APP_API_KEY=', '').Trim().Trim('"').Trim("'")
$selcomReference = Read-Host 'Unique order reference (reuse it when retrying this payment)'
$selcomPhone = Read-Host 'Customer mobile number'
$selcomAmount = [int](Read-Host 'Amount in whole TZS')
$selcomName = Read-Host 'Customer name'
$selcomEmail = Read-Host 'Customer email'
$selcomApi = Read-Host 'API base URL [http://127.0.0.1:3080]'
if (-not $selcomApi) { $selcomApi = 'http://127.0.0.1:3080' }
$selcomPayload = @{
    merchantReference = $selcomReference
    phone = $selcomPhone
    amount = $selcomAmount
    currency = 'TZS'
    customerName = $selcomName
    customerEmail = $selcomEmail
    description = 'Order payment'
} | ConvertTo-Json
$selcomHeaders = @{ 'X-API-Key' = $selcomAppKey; 'Idempotency-Key' = "payment-$selcomReference" }
Invoke-RestMethod -Method Post -Uri "$($selcomApi.TrimEnd('/'))/api/v1/payments/mobile" -ContentType 'application/json' -Headers $selcomHeaders -Body $selcomPayload | ConvertTo-Json -Depth 8
