param([string]$Root='C:\DemoData\FileSync')
$ErrorActionPreference='Stop'
if(Test-Path $Root){throw 'Use a new empty fixture root; existing files are never removed.'}
New-Item -ItemType Directory -Path "$Root\Folder A","$Root\Folder B" -Force|Out-Null
$same=[datetime]'2026-10-01T12:00:00Z'
function WriteSample([string]$Side,[string]$Relative,[string]$Text,[datetime]$Time){
 $file=Join-Path "$Root\$Side" $Relative
 New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force|Out-Null
 [IO.File]::WriteAllText($file,$Text,[Text.UTF8Encoding]::new($false))
 [IO.File]::SetLastWriteTimeUtc($file,$Time)
}
$padding=('Synthetic field observation; no personal data. ' * 1500)
foreach($n in 1..700){
 $group=[int][math]::Ceiling($n/10)
 $path='Projects\Shared\Group-{0:D2}\note-{1:D4}.txt' -f $group,$n
 foreach($side in @('Folder A','Folder B')){WriteSample $side $path "Shared note $n`r`n$padding" $same}
}
foreach($n in 1..100){
 $group=[int][math]::Ceiling($n/10)
 $path='Projects\Reports\Batch-{0:D2}\report-{1:D4}.txt' -f $group,$n
 WriteSample 'Folder A' $path "Updated report $n`r`n$padding" $same.AddDays(5)
 WriteSample 'Folder B' $path "Old report $n`r`nPending review." $same
}
foreach($n in 1..200){
 $group=[int][math]::Ceiling($n/20)
 WriteSample 'Folder A' ('Fieldwork\Batch-{0:D2}\new-note-{1:D4}.txt' -f $group,$n) "New note $n`r`n$padding" $same.AddDays(5)
 WriteSample 'Folder B' ('Archive\Batch-{0:D2}\obsolete-note-{1:D4}.txt' -f $group,$n) "Obsolete note $n`r`nKeep a recovery copy." $same
}
@{identicalPerSide=700;filesPerSide=1000;copies=200;overwrites=100;removals=200;synthetic=$true;layout='Projects/Shared, Projects/Reports, Fieldwork, Archive; grouped batches'}|ConvertTo-Json|Set-Content "$Root\fixture.json"