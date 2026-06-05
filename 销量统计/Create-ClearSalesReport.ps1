Add-Type -AssemblyName System.IO.Compression.FileSystem

$ErrorActionPreference = 'Stop'
$workDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$orderPath = (Get-ChildItem -LiteralPath $workDir -File -Filter '*20260529100257.xlsx' |
    Where-Object { $_.Name -notlike '~$*' } |
    Select-Object -First 1).FullName
$salesPath = (Get-ChildItem -LiteralPath $workDir -File -Filter '*.xlsx' |
    Where-Object {
        $_.Name -notlike '~$*' -and
        $_.Name -ne '__inspect_sales.xlsx' -and
        $_.FullName -ne $orderPath -and
        $_.Name -notlike '*stats*' -and
        $_.Name -notlike '*clear*' -and
        $_.Name -notlike '*report*'
    } |
    Sort-Object Length -Descending |
    Select-Object -First 1).FullName

if (-not $orderPath) { throw 'Order workbook was not found.' }
if (-not $salesPath) { throw 'Sales workbook was not found.' }

$outPath = Join-Path $workDir 'order_sku_daily_sales_report.xlsx'

function Get-ZipText($zip, [string]$path) {
    $entry = $zip.GetEntry($path)
    if (-not $entry) { return $null }
    $reader = [System.IO.StreamReader]::new($entry.Open())
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Get-SharedStrings($zip) {
    $text = Get-ZipText $zip 'xl/sharedStrings.xml'
    if (-not $text) { return @() }
    [xml]$xml = $text
    $ns = [System.Xml.XmlNamespaceManager]::new($xml.NameTable)
    $ns.AddNamespace('x', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    $items = @()
    foreach ($si in $xml.SelectNodes('//x:si', $ns)) {
        $items += (($si.SelectNodes('.//x:t', $ns) | ForEach-Object { $_.InnerText }) -join '')
    }
    return $items
}

function Get-ColName([string]$cellRef) {
    return [regex]::Match($cellRef, '^[A-Z]+').Value
}

function Convert-NumberToCol([int]$n) {
    $s = ''
    while ($n -gt 0) {
        $n--
        $s = [char]([int][char]'A' + ($n % 26)) + $s
        $n = [math]::Floor($n / 26)
    }
    return $s
}

function Get-CellValue($cell, $shared) {
    if ($null -eq $cell) { return '' }
    if ($cell.t -eq 's') { return $shared[[int]$cell.v] }
    if ($cell.t -eq 'inlineStr') {
        return (($cell.SelectNodes('.//*[local-name()="t"]') | ForEach-Object { $_.InnerText }) -join '')
    }
    if ($null -ne $cell.f -and $null -ne $cell.v) { return [string]$cell.v }
    if ($null -ne $cell.v) { return [string]$cell.v }
    return ''
}

function New-TextCell($doc, [string]$ref, [string]$value) {
    $cell = $doc.CreateElement('c', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    $cell.SetAttribute('r', $ref)
    $cell.SetAttribute('t', 'inlineStr')
    $is = $doc.CreateElement('is', $cell.NamespaceURI)
    $t = $doc.CreateElement('t', $cell.NamespaceURI)
    $t.InnerText = $value
    $is.AppendChild($t) | Out-Null
    $cell.AppendChild($is) | Out-Null
    return $cell
}

function New-NumberCell($doc, [string]$ref, [double]$value) {
    $cell = $doc.CreateElement('c', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    $cell.SetAttribute('r', $ref)
    $cell.SetAttribute('t', 'n')
    $v = $doc.CreateElement('v', $cell.NamespaceURI)
    $v.InnerText = [string]$value
    $cell.AppendChild($v) | Out-Null
    return $cell
}

function New-FormulaCell($doc, [string]$ref, [string]$formula, [string]$cachedValue) {
    $cell = $doc.CreateElement('c', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    $cell.SetAttribute('r', $ref)
    $cell.SetAttribute('t', 'str')
    $f = $doc.CreateElement('f', $cell.NamespaceURI)
    $f.InnerText = $formula
    $v = $doc.CreateElement('v', $cell.NamespaceURI)
    $v.InnerText = $cachedValue
    $cell.AppendChild($f) | Out-Null
    $cell.AppendChild($v) | Out-Null
    return $cell
}

function New-Row($doc, [int]$rowNumber, [array]$cells) {
    $row = $doc.CreateElement('row', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    $row.SetAttribute('r', [string]$rowNumber)
    foreach ($cell in $cells) { $row.AppendChild($cell) | Out-Null }
    return $row
}

function Copy-SharedRead([string]$source, [string]$dest) {
    $input = [System.IO.File]::Open($source, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $output = [System.IO.File]::Open($dest, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $input.CopyTo($output) } finally { $output.Dispose() }
    } finally {
        $input.Dispose()
    }
}

$orderZip = [System.IO.Compression.ZipFile]::OpenRead($orderPath)
try {
    $orderShared = Get-SharedStrings $orderZip
    [xml]$orderXml = Get-ZipText $orderZip 'xl/worksheets/sheet1.xml'
    $stats = @{}
    $skuNamesFromOrder = @{}
    $cancelRows = 0
    $validRows = 0
    $dates = @{}
    foreach ($row in $orderXml.worksheet.sheetData.row | Where-Object { [int]$_.r -ge 2 }) {
        $cells = @{}
        foreach ($cell in $row.c) { $cells[(Get-ColName $cell.r)] = Get-CellValue $cell $orderShared }
        $isCancelled = (($cells['B']) -and $cells['B'] -ne '-') -or ($cells['M'] -match '取消|cancel')
        if ($isCancelled) {
            $cancelRows++
            continue
        }
        if (-not $cells['A'] -or -not $cells['I']) { continue }
        $date = [datetime]::Parse($cells['A'])
        $dateKey = $date.ToString('yyyy-MM-dd')
        $sku = $cells['I']
        $qty = [double]$cells['T']
        if ($qty -eq 0) { $qty = 1 }
        $key = "$dateKey|$sku"
        if (-not $stats.ContainsKey($key)) { $stats[$key] = 0.0 }
        $stats[$key] += $qty
        $dates[$dateKey] = 1
        if (-not $skuNamesFromOrder.ContainsKey($sku)) { $skuNamesFromOrder[$sku] = $cells['F'] }
        $validRows++
    }
} finally {
    $orderZip.Dispose()
}

Copy-SharedRead $salesPath $outPath

$zip = [System.IO.Compression.ZipFile]::Open($outPath, [System.IO.Compression.ZipArchiveMode]::Update)
try {
    $shared = Get-SharedStrings $zip
    [xml]$brazilSheet = Get-ZipText $zip 'xl/worksheets/sheet2.xml'
    $skuMeta = @{}
    foreach ($row in $brazilSheet.worksheet.sheetData.row | Where-Object { [int]$_.r -ge 3 }) {
        $rowNumber = [string]$row.r
        $skuCell = $row.c | Where-Object { $_.r -eq ('B' + $rowNumber) } | Select-Object -First 1
        $sku = Get-CellValue $skuCell $shared
        if (-not $sku) { continue }
        $nameCell = $row.c | Where-Object { $_.r -eq ('C' + $rowNumber) } | Select-Object -First 1
        $imageCell = $row.c | Where-Object { $_.r -eq ('D' + $rowNumber) } | Select-Object -First 1
        $formula = $null
        $cached = $null
        if ($imageCell -and $imageCell.f) {
            $formula = [string]$imageCell.f
            $cached = [string]$imageCell.v
        }
        $skuMeta[$sku] = [pscustomobject]@{
            Name = Get-CellValue $nameCell $shared
            Formula = $formula
            Cached = $cached
        }
    }

    $uniqueSkus = $stats.Keys | ForEach-Object { ($_ -split '\|', 2)[1] } | Sort-Object -Unique
    $dateList = $dates.Keys | Sort-Object

    $doc = [xml]'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/><sheetData/></worksheet>'
    $sheetData = $doc.SelectSingleNode("//*[local-name()='sheetData']")

    $headers = @('SKU', ([char]0x54c1 + [char]0x540d), ([char]0x56fe + [char]0x7247), ([char]0x5408 + [char]0x8ba1)) + $dateList
    $headerCells = @()
    for ($i = 0; $i -lt $headers.Count; $i++) {
        $headerCells += New-TextCell $doc ((Convert-NumberToCol ($i + 1)) + '1') ([string]$headers[$i])
    }
    $sheetData.AppendChild((New-Row $doc 1 $headerCells)) | Out-Null

    $rowNumber = 2
    $matchedImages = 0
    foreach ($sku in $uniqueSkus) {
        $meta = $skuMeta[$sku]
        $name = $skuNamesFromOrder[$sku]
        if ($meta -and $meta.Name) { $name = $meta.Name }
        $total = 0.0
        foreach ($dateKey in $dateList) {
            $key = "$dateKey|$sku"
            if ($stats.ContainsKey($key)) { $total += $stats[$key] }
        }

        $cells = @(
            (New-TextCell $doc ('A' + $rowNumber) $sku),
            (New-TextCell $doc ('B' + $rowNumber) $name)
        )
        if ($meta -and $meta.Formula) {
            $cells += New-FormulaCell $doc ('C' + $rowNumber) $meta.Formula $meta.Cached
            $matchedImages++
        } else {
            $cells += New-TextCell $doc ('C' + $rowNumber) ''
        }
        $cells += New-NumberCell $doc ('D' + $rowNumber) $total
        for ($i = 0; $i -lt $dateList.Count; $i++) {
            $dateKey = $dateList[$i]
            $value = 0.0
            $statKey = "$dateKey|$sku"
            if ($stats.ContainsKey($statKey)) { $value = $stats[$statKey] }
            $cells += New-NumberCell $doc ((Convert-NumberToCol ($i + 5)) + $rowNumber) $value
        }
        $row = New-Row $doc $rowNumber $cells
        $row.SetAttribute('ht', '54')
        $row.SetAttribute('customHeight', '1')
        $sheetData.AppendChild($row) | Out-Null
        $rowNumber++
    }

    $lastCol = Convert-NumberToCol ($dateList.Count + 4)
    $worksheetNode = $doc.SelectSingleNode("//*[local-name()='worksheet']")
    $sheetViewsNode = $doc.SelectSingleNode("//*[local-name()='sheetViews']")
    $dimension = $doc.CreateElement('dimension', $worksheetNode.NamespaceURI)
    $dimension.SetAttribute('ref', "A1:$lastCol$($rowNumber - 1)")
    $worksheetNode.InsertBefore($dimension, $sheetViewsNode) | Out-Null

    $cols = $doc.CreateElement('cols', $worksheetNode.NamespaceURI)
    $widths = @(18, 32, 18, 10)
    for ($i = 1; $i -le ($dateList.Count + 4); $i++) {
        $col = $doc.CreateElement('col', $worksheetNode.NamespaceURI)
        $col.SetAttribute('min', [string]$i)
        $col.SetAttribute('max', [string]$i)
        $width = if ($i -le 4) { $widths[$i - 1] } else { 12 }
        $col.SetAttribute('width', [string]$width)
        $col.SetAttribute('customWidth', '1')
        $cols.AppendChild($col) | Out-Null
    }
    $worksheetNode.InsertAfter($cols, $sheetViewsNode) | Out-Null

    $entry = $zip.GetEntry('xl/worksheets/sheet6.xml')
    if ($entry) { $entry.Delete() }
    $newEntry = $zip.CreateEntry('xl/worksheets/sheet6.xml')
    $writer = [System.IO.StreamWriter]::new($newEntry.Open(), [System.Text.UTF8Encoding]::new($false))
    try { $doc.Save($writer) } finally { $writer.Dispose() }

    [xml]$workbook = Get-ZipText $zip 'xl/workbook.xml'
    $ns = [System.Xml.XmlNamespaceManager]::new($workbook.NameTable)
    $ns.AddNamespace('x', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    $sheets = $workbook.SelectNodes('//x:sheet', $ns)
    $targetSheet = $sheets | Where-Object { $_.sheetId -eq '6' } | Select-Object -First 1
    if ($targetSheet) {
        $sheetName = ([char]0x8ba2 + [char]0x5355 + [char]0x9500 + [char]0x91cf + [char]0x7edf + [char]0x8ba1)
        $targetSheet.SetAttribute('name', $sheetName)
    }
    $workbookEntry = $zip.GetEntry('xl/workbook.xml')
    $workbookEntry.Delete()
    $newWorkbookEntry = $zip.CreateEntry('xl/workbook.xml')
    $wbWriter = [System.IO.StreamWriter]::new($newWorkbookEntry.Open(), [System.Text.UTF8Encoding]::new($false))
    try { $workbook.Save($wbWriter) } finally { $wbWriter.Dispose() }
} finally {
    $zip.Dispose()
}

[pscustomobject]@{
    OutputFile = $outPath
    ValidOrderRows = $validRows
    CancelledRows = $cancelRows
    SkuCount = ($stats.Keys | ForEach-Object { ($_ -split '\|', 2)[1] } | Sort-Object -Unique).Count
    DateCount = $dates.Count
    MatchedImageCount = $matchedImages
} | Format-List
