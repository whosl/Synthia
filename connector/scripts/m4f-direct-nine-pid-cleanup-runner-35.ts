import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const COMMAND_LIMIT = 7_000;

export const CANDIDATE35_ID = "m4f-direct-nine-pid-cleanup-prod-20260831-35";
export const CANDIDATE34_RECORD_PATH =
  "/private/tmp/m4f-direct-nine-pid-stale-parent-adjudication-prod-20260831-34.json";
export const CANDIDATE34_RECORD_SHA256 =
  "151159584935fc7d016ea67fefb7deddc09fa5c26dfbd1f30b1e1d8f613ca9b5";
export const CANDIDATE34_SOURCE_SHA256 =
  "153faca2de49475e5976df669096135fa9b754981e57a5c540c67c2cbbcdd86e";
export const CANDIDATE34_TEST_SHA256 =
  "2d77fedbe6a622ee5eb36a67d169a44f6b96c7a32a094ef4519dfff3d2639b91";
export const CANDIDATE31_RECORD_PATH =
  "/private/tmp/m4f-direct-attempt2-residue-nine-pid-preflight-prod-20260830-31-evidence/preflight-record.json";

export interface Candidate35Target {
  ordinal: number;
  group: 1 | 2 | 3;
  role: "powershell" | "cmd" | "conhost";
  pid: number;
  parent_pid: number;
  name: "powershell.exe" | "cmd.exe" | "conhost.exe";
  creation_utc: string;
  session_id: 0;
  executable_path: string;
  command_length: number;
  command_sha256: string;
}

export const CANDIDATE35_TARGETS: readonly Candidate35Target[] = [
  { ordinal: 1, group: 1, role: "powershell", pid: 44768, parent_pid: 56576,
    name: "powershell.exe", creation_utc: "2026-08-28T16:25:51.0137880Z", session_id: 0,
    executable_path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    command_length: 1183, command_sha256: "8666564baaf3aa762b67d0eb4b8d288ab2f2611bad85e0046dc5b07455a0b5fc" },
  { ordinal: 2, group: 1, role: "cmd", pid: 56576, parent_pid: 6100,
    name: "cmd.exe", creation_utc: "2026-08-28T16:25:50.9870650Z", session_id: 0,
    executable_path: "c:\\windows\\system32\\cmd.exe", command_length: 1217,
    command_sha256: "5bc4c97b1fd21194056191199161af8371483e645131cf7c32a83018ae5be99e" },
  { ordinal: 3, group: 1, role: "conhost", pid: 64484, parent_pid: 56576,
    name: "conhost.exe", creation_utc: "2026-08-28T16:25:50.9908920Z", session_id: 0,
    executable_path: "C:\\WINDOWS\\system32\\conhost.exe", command_length: 39,
    command_sha256: "417222c4a0ecb4d60a457ebe8e26fddf3d5406bffb16a5c59af8eeb241beca51" },
  { ordinal: 4, group: 2, role: "powershell", pid: 58908, parent_pid: 67048,
    name: "powershell.exe", creation_utc: "2026-08-28T17:12:52.5233860Z", session_id: 0,
    executable_path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    command_length: 1183, command_sha256: "8666564baaf3aa762b67d0eb4b8d288ab2f2611bad85e0046dc5b07455a0b5fc" },
  { ordinal: 5, group: 2, role: "cmd", pid: 67048, parent_pid: 24260,
    name: "cmd.exe", creation_utc: "2026-08-28T17:12:52.4952390Z", session_id: 0,
    executable_path: "c:\\windows\\system32\\cmd.exe", command_length: 1217,
    command_sha256: "5bc4c97b1fd21194056191199161af8371483e645131cf7c32a83018ae5be99e" },
  { ordinal: 6, group: 2, role: "conhost", pid: 66316, parent_pid: 67048,
    name: "conhost.exe", creation_utc: "2026-08-28T17:12:52.5009290Z", session_id: 0,
    executable_path: "C:\\WINDOWS\\system32\\conhost.exe", command_length: 39,
    command_sha256: "417222c4a0ecb4d60a457ebe8e26fddf3d5406bffb16a5c59af8eeb241beca51" },
  { ordinal: 7, group: 3, role: "powershell", pid: 39016, parent_pid: 48664,
    name: "powershell.exe", creation_utc: "2026-08-30T14:10:50.2348230Z", session_id: 0,
    executable_path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    command_length: 6839, command_sha256: "bdb85e6efc55c06db037273b95bad470bad22c42dbdae3b551595914a2fb1d3a" },
  { ordinal: 8, group: 3, role: "cmd", pid: 48664, parent_pid: 62912,
    name: "cmd.exe", creation_utc: "2026-08-30T14:10:50.2066440Z", session_id: 0,
    executable_path: "c:\\windows\\system32\\cmd.exe", command_length: 6873,
    command_sha256: "cbf2ee2b15ffc9fcc16611caec46e45565d5169ccb3a100f596e8f11da5b0651" },
  { ordinal: 9, group: 3, role: "conhost", pid: 66340, parent_pid: 48664,
    name: "conhost.exe", creation_utc: "2026-08-30T14:10:50.2104140Z", session_id: 0,
    executable_path: "C:\\WINDOWS\\system32\\conhost.exe", command_length: 39,
    command_sha256: "417222c4a0ecb4d60a457ebe8e26fddf3d5406bffb16a5c59af8eeb241beca51" },
] as const;

export interface Candidate35Config {
  schema: "synthia-m4f-direct-nine-pid-cleanup-35-config.v1";
  cleanup_id: typeof CANDIDATE35_ID;
  target_host: "100.96.223.49";
  target_computer: "DESKTOP-DVFFB09";
  target_identity_name: "desktop-dvffb09\\admin";
  target_identity_sid: "S-1-5-21-2561815994-3878748218-1101284459-1001";
  candidate31_record_path: string;
  candidate31_record_sha256: "4efad9fab8445eeee887e564fe6362f1341f96500f7926b8ddee690ee50fa8aa";
  candidate34_record_path: string;
  candidate34_record_sha256: typeof CANDIDATE34_RECORD_SHA256;
  expected_candidate34_source_sha256: typeof CANDIDATE34_SOURCE_SHA256;
  expected_candidate34_test_sha256: typeof CANDIDATE34_TEST_SHA256;
  expected_source_sha256: string;
  expected_test_sha256: string;
  expected_transport_source_sha256: string;
  effect_wait_ms: 5_000;
  remote_deadline_seconds: 60;
}

export interface Candidate35BuiltPayload {
  business_script: string;
  business_script_sha256: string;
  business_script_length: number;
  compressed_business_script: Buffer;
  remote_command: string;
  remote_command_sha256: string;
  remote_command_length: number;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}";
  }
  return JSON.stringify(value);
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function validateCandidate35Config(value: unknown): Candidate35Config {
  const config = object(value);
  const keys = [
    "candidate31_record_path", "candidate31_record_sha256", "candidate34_record_path",
    "candidate34_record_sha256", "cleanup_id", "effect_wait_ms", "expected_candidate34_source_sha256",
    "expected_candidate34_test_sha256", "expected_source_sha256", "expected_test_sha256",
    "expected_transport_source_sha256", "remote_deadline_seconds", "schema", "target_computer",
    "target_host", "target_identity_name", "target_identity_sid",
  ];
  if (!config || Object.keys(config).sort().join("|") !== keys.sort().join("|")
    || config.schema !== "synthia-m4f-direct-nine-pid-cleanup-35-config.v1"
    || config.cleanup_id !== CANDIDATE35_ID || !SAFE_ID.test(config.cleanup_id)
    || config.target_host !== "100.96.223.49" || config.target_computer !== "DESKTOP-DVFFB09"
    || config.target_identity_name !== "desktop-dvffb09\\admin"
    || config.target_identity_sid !== "S-1-5-21-2561815994-3878748218-1101284459-1001"
    || config.candidate31_record_path !== CANDIDATE31_RECORD_PATH
    || config.candidate34_record_path !== CANDIDATE34_RECORD_PATH
    || config.candidate31_record_sha256 !== "4efad9fab8445eeee887e564fe6362f1341f96500f7926b8ddee690ee50fa8aa"
    || config.effect_wait_ms !== 5_000 || config.remote_deadline_seconds !== 60
    || config.candidate34_record_sha256 !== CANDIDATE34_RECORD_SHA256
    || config.expected_candidate34_source_sha256 !== CANDIDATE34_SOURCE_SHA256
    || config.expected_candidate34_test_sha256 !== CANDIDATE34_TEST_SHA256
    || [config.expected_source_sha256, config.expected_test_sha256,
      config.expected_transport_source_sha256].some((item) => typeof item !== "string" || !HASH.test(item))) {
    throw new Error("M4F_CANDIDATE35_CONFIG_INVALID");
  }
  return value as Candidate35Config;
}

function remotePlan(config: Candidate35Config) {
  return {
    i: config.cleanup_id, c: config.target_computer, n: config.target_identity_name,
    s: config.target_identity_sid, d: config.remote_deadline_seconds, w: config.effect_wait_ms,
    c31: config.candidate31_record_sha256, c34: config.candidate34_record_sha256,
    worker: [13644, 2712, "node.exe", "2026-08-14T08:02:31.2903580Z", 0,
      "D:\\softwares\\Nodejs\\node.exe", true, 66,
      "e5d000e033425243c23868bbede8cbd67d09872e5379c05cf6b8371ef175998f"],
    t: CANDIDATE35_TARGETS.map((target) => [
      target.ordinal, target.group, target.role, target.pid, target.parent_pid, target.name,
      target.creation_utc, target.session_id, target.executable_path, target.command_length,
      target.command_sha256,
    ]),
  };
}

export function candidate35StartToken(target: Candidate35Target): string {
  return sha256(canonicalJson([
    target.ordinal, target.group, target.role, target.pid, target.parent_pid, target.name,
    target.creation_utc, target.session_id, target.executable_path, target.command_length,
    target.command_sha256,
  ]));
}

export function buildCandidate35BusinessScript(rawConfig: unknown): string {
  const config = validateCandidate35Config(rawConfig);
  const planJson = JSON.stringify(remotePlan(config)).replaceAll("'", "''");
  const verboseSource = [
    "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    `$C=('${planJson}'|ConvertFrom-Json)`,
    "$D=[DateTime]::UtcNow.AddSeconds([int]$C.d);$Clock=[Diagnostics.Stopwatch]::StartNew();$DeadlineMilliseconds=[int]$C.d*1000;$R=@{};$P=@{};$S=@{};$Power=@{};$Phase='before_start';$Pending=$false;$DiagnosticPids=@();$SshRoot=0;$PresentCount=0;$MissingParentPids=@(6100,24260,62912);$TargetPids=New-Object Collections.Generic.HashSet[int];foreach($Target in $C.t){[void]$TargetPids.Add([int]$Target[3])}",
    "function Get-SynthiaM4f35Sha256([string]$Value){([BitConverter]::ToString(([Security.Cryptography.SHA256]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))-replace '-','').ToLowerInvariant()}",
    "function Get-SynthiaM4f35MicrosecondTicks([DateTime]$Value){$Ticks=$Value.ToUniversalTime().Ticks;[long]($Ticks-($Ticks%10))}",
    "function Write-SynthiaM4f35Marker([string]$MarkerPhase,[string]$MarkerStatus,[System.Collections.IDictionary]$MarkerPayload){[Console]::Out.WriteLine(([ordered]@{schema='synthia-m4f-direct-nine-pid-cleanup-35-marker.v1';cleanup_id=$C.i;phase=$MarkerPhase;status=$MarkerStatus;observed_at_utc=[DateTime]::UtcNow.ToString('o');payload=$MarkerPayload}|ConvertTo-Json -Compress -Depth 14));[Console]::Out.Flush()}",
    "function ConvertTo-SynthiaM4f35ProcessRow([object]$ProcessRow){$Path=$null;if($null-ne$ProcessRow.ExecutablePath){$Path=[string]$ProcessRow.ExecutablePath};$Present=$null-ne$ProcessRow.CommandLine;$Length=$null;$Hash=$null;if($Present){$Command=[string]$ProcessRow.CommandLine;$Length=$Command.Length;$Hash=Get-SynthiaM4f35Sha256 $Command};,@([int]$ProcessRow.ProcessId,[int]$ProcessRow.ParentProcessId,([string]$ProcessRow.Name).ToLowerInvariant(),$ProcessRow.CreationDate.ToUniversalTime().ToString('o'),[int]$ProcessRow.SessionId,$Path,$Present,$Length,$Hash)}",
    "function Get-SynthiaM4f35Snapshot(){$Rows=@(Get-CimInstance Win32_Process -ErrorAction Stop);$ByPid=@{};foreach($ProcessRow in $Rows){$ByPid[[int]$ProcessRow.ProcessId]=$ProcessRow};$Tcp=@(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -ErrorAction Stop|Where-Object{$_.State-eq 2-and($_.LocalPort-eq 8443-or$_.LocalPort-eq 18443)}|Sort-Object LocalPort,LocalAddress,OwningProcess);$Listeners=@($Tcp|ForEach-Object{,[ordered]@{local_address=[string]$_.LocalAddress;local_port=[int]$_.LocalPort;owning_pid=[int]$_.OwningProcess}});[ordered]@{rows=$Rows;by=$ByPid;listeners=$Listeners}}",
    "function Get-SynthiaM4f35AncestorChain([int]$StartPid,[object]$ByPid){$Rows=New-Object Collections.Generic.List[object];$Seen=@{};$Child=$ByPid[$StartPid];while($null-ne$Child-and[int]$Child.ParentProcessId-gt 0){$ParentPid=[int]$Child.ParentProcessId;if($Seen.ContainsKey($ParentPid)){return [ordered]@{rows=$Rows.ToArray();terminal='cycle';pid=$ParentPid}};$Seen[$ParentPid]=$true;$Parent=$ByPid[$ParentPid];if($null-eq$Parent){return [ordered]@{rows=$Rows.ToArray();terminal='missing_parent';pid=$ParentPid}};$Rows.Add((ConvertTo-SynthiaM4f35ProcessRow $Parent));if((Get-SynthiaM4f35MicrosecondTicks $Parent.CreationDate)-gt(Get-SynthiaM4f35MicrosecondTicks $Child.CreationDate)){return [ordered]@{rows=$Rows.ToArray();terminal='invalid_edge';pid=$ParentPid}};$Child=$Parent};[ordered]@{rows=$Rows.ToArray();terminal='zero';pid=0}}",
    "function Test-SynthiaM4f35StaleBoundary([object]$Chain){$Rows=@($Chain.rows);if($Chain.terminal-cne'invalid_edge'-or$Chain.pid-ne 1204-or$Rows.Count-lt 3){return $false};$Services=@(1448,1304,'services.exe','2026-08-12T22:31:30.2114380Z',0,$null,$false,$null,$null);$Wininit=@(1304,1204,'wininit.exe','2026-08-12T22:31:30.1596200Z',0,$null,$false,$null,$null);$Stale=@(1204,1448,'svchost.exe','2026-08-12T22:31:30.7301590Z',0,'C:\\WINDOWS\\System32\\svchost.exe',$true,80,'28badc7dddcdb48483f2880e3982160297bf49c3e21da9939589ebd0503bd8b8');return(($Rows[$Rows.Count-3]|ConvertTo-Json -Compress)-ceq($Services|ConvertTo-Json -Compress)-and($Rows[$Rows.Count-2]|ConvertTo-Json -Compress)-ceq($Wininit|ConvertTo-Json -Compress)-and($Rows[$Rows.Count-1]|ConvertTo-Json -Compress)-ceq($Stale|ConvertTo-Json -Compress))}",
    "function Test-SynthiaM4f35TargetExact([object]$ProcessRow,[object]$Target){$Observed=ConvertTo-SynthiaM4f35ProcessRow $ProcessRow;$Expected=@([int]$Target[3],[int]$Target[4],[string]$Target[5],[string]$Target[6],[int]$Target[7],[string]$Target[8],$true,[int]$Target[9],[string]$Target[10]);return((ConvertTo-Json -InputObject $Observed -Compress)-ceq(ConvertTo-Json -InputObject $Expected -Compress))}",
    "function Test-SynthiaM4f35TargetForest([object]$ByPid,[object]$AllRows){foreach($MissingPid in $MissingParentPids){if($ByPid.ContainsKey([int]$MissingPid)){return $false}};foreach($Target in $C.t){$ParentPid=[int]$Target[3];$ExpectedChildren=@($C.t|Where-Object{[int]$_[4]-eq$ParentPid-and$ByPid.ContainsKey([int]$_[3])}|ForEach-Object{[int]$_[3]}|Sort-Object);$ActualChildren=@($AllRows|Where-Object{[int]$_.ParentProcessId-eq$ParentPid}|ForEach-Object{[int]$_.ProcessId}|Sort-Object);if(($ExpectedChildren|ConvertTo-Json -Compress)-cne($ActualChildren|ConvertTo-Json -Compress)){return $false}};return $true}",
    "function Test-SynthiaM4f35TargetRelationships([object]$ByPid){foreach($Target in $C.t){$TargetPid=[int]$Target[3];if(-not$ByPid.ContainsKey($TargetPid)){continue};$Chain=Get-SynthiaM4f35AncestorChain $TargetPid $ByPid;if($Chain.terminal-cne'missing_parent'){return $false};foreach($Ancestor in @($Chain.rows)){$AncestorPid=[int]$Ancestor[0];if(-not$TargetPids.Contains($AncestorPid)-or$P.ContainsKey($AncestorPid)){return $false};$ExpectedTarget=@($C.t|Where-Object{[int]$_[3]-eq$AncestorPid});$ExpectedRow=@([int]$ExpectedTarget[0][3],[int]$ExpectedTarget[0][4],[string]$ExpectedTarget[0][5],[string]$ExpectedTarget[0][6],[int]$ExpectedTarget[0][7],[string]$ExpectedTarget[0][8],$true,[int]$ExpectedTarget[0][9],[string]$ExpectedTarget[0][10]);if($ExpectedTarget.Count-ne 1-or($Ancestor|ConvertTo-Json -Compress)-cne($ExpectedRow|ConvertTo-Json -Compress)){return $false}};$TerminalPid=[int]$Chain.pid;if(-not($TargetPids.Contains($TerminalPid)-or$MissingParentPids-contains$TerminalPid)){return $false}};return $true}",
    "function Test-SynthiaM4f35Guard([object]$ByPid,[object]$Listeners,[object]$AllRows){$ExpectedListeners=@([ordered]@{local_address='0.0.0.0';local_port=8443;owning_pid=13644});if(($Listeners|ConvertTo-Json -Compress)-cne($ExpectedListeners|ConvertTo-Json -Compress)){return $false};if(-not(Test-SynthiaM4f35StaleBoundary (Get-SynthiaM4f35AncestorChain $PID $ByPid))-or-not(Test-SynthiaM4f35StaleBoundary (Get-SynthiaM4f35AncestorChain 13644 $ByPid))-or-not(Test-SynthiaM4f35TargetForest $ByPid $AllRows)-or-not(Test-SynthiaM4f35TargetRelationships $ByPid)){return $false};$Now=@($SshRoot);$Changed=$true;while($Changed){$Changed=$false;foreach($ProcessRow in $AllRows){$ParentPid=[int]$ProcessRow.ParentProcessId;if($Now-contains$ParentPid-and-not($Now-contains[int]$ProcessRow.ProcessId)){$Parent=$ByPid[$ParentPid];if($null-eq$Parent-or(Get-SynthiaM4f35MicrosecondTicks $Parent.CreationDate)-gt(Get-SynthiaM4f35MicrosecondTicks $ProcessRow.CreationDate)){return $false};$Now+=[int]$ProcessRow.ProcessId;$Changed=$true}}};if((@($Now|Sort-Object)|ConvertTo-Json -Compress)-cne(@($DiagnosticPids|Sort-Object)|ConvertTo-Json -Compress)){return $false};foreach($Key in $P.Keys){$ProcessRow=$ByPid[[int]$Key];if($null-eq$ProcessRow-or((ConvertTo-SynthiaM4f35ProcessRow $ProcessRow|ConvertTo-Json -Compress)-cne[string]$P[$Key])){return $false}};$Worker=$R['worker'];$WorkerHandleExact=([string]$Worker.handle.DangerousGetHandle().ToInt64()-cne$Worker.raw-or(Get-SynthiaM4f35MicrosecondTicks $Worker.process.StartTime)-ne(Get-SynthiaM4f35MicrosecondTicks([DateTime]$Worker.creation)));if($Worker.process.HasExited-or$Worker.handle.IsInvalid-or$Worker.handle.IsClosed-or$WorkerHandleExact){return $false};if(@($AllRows|Where-Object{[int]$_.ParentProcessId-eq 13644}).Count-ne 0){return $false};foreach($Target in $C.t){$Ordinal=[int]$Target[0];$TargetPid=[int]$Target[3];if($S[$Ordinal]-cne'present'){if($ByPid.ContainsKey($TargetPid)){return $false};continue};$Entry=$R[$Ordinal];$EntryHandleExact=([string]$Entry.handle.DangerousGetHandle().ToInt64()-cne$Entry.raw);if($Entry.handle.IsInvalid-or$Entry.handle.IsClosed-or$EntryHandleExact){return $false};$PowerOrdinal=(($Ordinal-1)-($Ordinal-1)%3)+1;if($Entry.process.HasExited){if([string]$Target[2]-ceq'powershell'-or-not$Power.ContainsKey($PowerOrdinal)-or$ByPid.ContainsKey($TargetPid)){return $false}}else{if(-not$ByPid.ContainsKey($TargetPid)-or-not(Test-SynthiaM4f35TargetExact $ByPid[$TargetPid] $Target)-or(Get-SynthiaM4f35MicrosecondTicks $Entry.process.StartTime)-ne(Get-SynthiaM4f35MicrosecondTicks([DateTime]$Entry.creation))){return $false}}};return $true}",
    "try{$Phase='start';Write-SynthiaM4f35Marker 'start' 'observed' ([ordered]@{current_pid=$PID;target_count=9;c31=$C.c31;c34=$C.c34})",
    "$id=[Security.Principal.WindowsIdentity]::GetCurrent();if($env:COMPUTERNAME-cne$C.c-or$id.Name.ToLowerInvariant()-cne$C.n-or$id.User.Value-cne$C.s){throw 'IDENTITY'}",
    "$Phase='preflight_snapshot';$o=Get-SynthiaM4f35Snapshot;$b=$o.by;if(-not(Test-SynthiaM4f35StaleBoundary (Get-SynthiaM4f35AncestorChain $PID $b))-or-not(Test-SynthiaM4f35StaleBoundary (Get-SynthiaM4f35AncestorChain 13644 $b))){throw 'STALE_BOUNDARY'}",
    "$cc=Get-SynthiaM4f35AncestorChain $PID $b;$wc=Get-SynthiaM4f35AncestorChain 13644 $b;$ss=@($cc.rows|Where-Object{$_[2]-ceq'sshd.exe'}|Select-Object -First 1);if($ss.Count-ne 1){throw 'SSH_ROOT'};$SshRoot=[int]$ss[0][0];$DiagnosticPids=@($SshRoot);$Changed=$true;while($Changed){$Changed=$false;foreach($ProcessRow in $o.rows){$ParentPid=[int]$ProcessRow.ParentProcessId;if($DiagnosticPids-contains$ParentPid-and-not($DiagnosticPids-contains[int]$ProcessRow.ProcessId)){$Parent=$b[$ParentPid];if($null-eq$Parent-or(Get-SynthiaM4f35MicrosecondTicks $Parent.CreationDate)-gt(Get-SynthiaM4f35MicrosecondTicks $ProcessRow.CreationDate)){throw 'DIAGNOSTIC_EDGE'};$DiagnosticPids+=[int]$ProcessRow.ProcessId;$Changed=$true}}};foreach($ProtectedPid in @($DiagnosticPids+@($cc.rows|ForEach-Object{$_[0]})+@($wc.rows|ForEach-Object{$_[0]})+13644)){if($TargetPids.Contains([int]$ProtectedPid)){throw 'PROTECTED_TARGET_OVERLAP'};$P[[int]$ProtectedPid]=(ConvertTo-SynthiaM4f35ProcessRow $b[[int]$ProtectedPid]|ConvertTo-Json -Compress)};if(-not(Test-SynthiaM4f35TargetForest $b $o.rows)-or-not(Test-SynthiaM4f35TargetRelationships $b)){throw 'TARGET_RELATIONSHIP'}",
    "if((ConvertTo-Json -InputObject (ConvertTo-SynthiaM4f35ProcessRow $b[13644]) -Compress)-cne(ConvertTo-Json -InputObject $C.worker -Compress)){throw 'WORKER_IDENTITY'};$wr=[Diagnostics.Process]::GetProcessById(13644);$wh=$wr.SafeHandle;$wa=$false;$wh.DangerousAddRef([ref]$wa);if(-not$wa-or$wr.HasExited-or(Get-SynthiaM4f35MicrosecondTicks $wr.StartTime)-ne(Get-SynthiaM4f35MicrosecondTicks([DateTime][string]$C.worker[3]))){throw 'WORKER_HANDLE'};$R['worker']=[ordered]@{process=$wr;handle=$wh;add=$wa;raw=[string]$wh.DangerousGetHandle().ToInt64();role='worker';creation=[string]$C.worker[3]}",
    "$states=New-Object Collections.Generic.List[object];foreach($t in $C.t){$k=[int]$t[0];$Row=$b[[int]$t[3]];if($null-eq$Row){$S[$k]='absent';$states.Add(@($k,[int]$t[3],'absent',$null));continue};if(-not(Test-SynthiaM4f35TargetExact $Row $t)){throw 'TARGET_MISMATCH'};$Proc=[Diagnostics.Process]::GetProcessById([int]$t[3]);$h=$Proc.SafeHandle;$a=$false;$h.DangerousAddRef([ref]$a);if(-not$a-or$Proc.Id-ne[int]$t[3]-or$Proc.ProcessName.ToLowerInvariant()-cne(([string]$t[5])-replace'\\.exe$','')-or$Proc.HasExited-or(Get-SynthiaM4f35MicrosecondTicks $Proc.StartTime)-ne(Get-SynthiaM4f35MicrosecondTicks([DateTime][string]$t[6]))){throw 'TARGET_HANDLE'};$R[$k]=[ordered]@{process=$Proc;handle=$h;add=$a;raw=[string]$h.DangerousGetHandle().ToInt64();role=[string]$t[2];creation=[string]$t[6]};$S[$k]='present';$PresentCount+=1;$states.Add(@($k,[int]$t[3],'present',[string]$R[$k].raw))}",
    "$Phase='preflight_complete';if(-not(Test-SynthiaM4f35Guard $b $o.listeners $o.rows)){throw 'PROTECTION'};Write-SynthiaM4f35Marker 'preflight' 'observed' ([ordered]@{target_states=$states.ToArray();retained_count=$PresentCount;worker_retained=$true;authority='candidate31_historical_exact';stale_exact=$true})",
    "foreach($t in $C.t){$ord=[int]$t[0];$token=Get-SynthiaM4f35Sha256(($t|ConvertTo-Json -Compress));$Phase='before_effect_'+$ord;if($S[$ord]-ceq'absent'){if([string]$t[2]-ceq'powershell'){$Power[$ord]='absent'};Write-SynthiaM4f35Marker 'absent_skip' 'observed' ([ordered]@{ordinal=$ord;pid=[int]$t[3];start_token=$token});continue};if($Clock.ElapsedMilliseconds-ge$DeadlineMilliseconds-or[DateTime]::UtcNow-ge$D){throw 'DEADLINE'};$o=Get-SynthiaM4f35Snapshot;$b=$o.by;if(-not(Test-SynthiaM4f35Guard $b $o.listeners $o.rows)){throw 'PROTECTION_DRIFT'};$RemainingMilliseconds=$DeadlineMilliseconds-[int]$Clock.ElapsedMilliseconds;if($RemainingMilliseconds-le 0-or[DateTime]::UtcNow-ge$D){throw 'DEADLINE'};$e=$R[$ord];$powerOrdinal=(($ord-1)-($ord-1)%3)+1;if($e.process.HasExited){if([string]$t[2]-ceq'powershell'-or-not$Power.ContainsKey($powerOrdinal)-or$b.ContainsKey([int]$t[3])){throw 'UNEXPECTED_EXIT'};$S[$ord]='resolved';Write-SynthiaM4f35Marker 'natural_exit' 'observed' ([ordered]@{ordinal=$ord;pid=[int]$t[3];after_ordinal=$powerOrdinal;leader_resolution=[string]$Power[$powerOrdinal];raw_handle=$e.raw;start_token=$token});continue};if([string]$t[2]-cne'powershell'-and-not$Power.ContainsKey($powerOrdinal)){throw 'POWER_ORDER'};$Phase='effect_start_'+$ord;$Pending=$true;Write-SynthiaM4f35Marker 'effect_start' 'started' ([ordered]@{ordinal=$ord;pid=[int]$t[3];raw_handle=$e.raw;start_token=$token});$e.process.Kill();$WaitMilliseconds=[Math]::Min([int]$C.w,$RemainingMilliseconds);if($WaitMilliseconds-le 0-or-not$e.process.WaitForExit($WaitMilliseconds)-or-not$e.process.HasExited){throw 'EFFECT_TIMEOUT'};$Pending=$false;$S[$ord]='resolved';if([string]$t[2]-ceq'powershell'){$Power[$ord]='killed'};Write-SynthiaM4f35Marker 'effect_result' 'observed' ([ordered]@{ordinal=$ord;pid=[int]$t[3];effect='same_process_instance_kill_completed';has_exited=$true;raw_handle=$e.raw;start_token=$token})}",
    "$Phase='postflight';$o=Get-SynthiaM4f35Snapshot;$b=$o.by;if(-not(Test-SynthiaM4f35Guard $b $o.listeners $o.rows)){throw 'POST_PROTECTION'};$left=@($C.t|Where-Object{$b.ContainsKey([int]$_[3])});if($left.Count-ne 0){throw 'POST_TARGET_PRESENT'};Write-SynthiaM4f35Marker 'complete' 'complete' ([ordered]@{cleanup_completed=$true;present_count=$PresentCount;absent_count=9-$PresentCount;retry_permitted=$false})",
    "}catch{Write-SynthiaM4f35Marker 'failure' 'partial_unknown' ([ordered]@{phase=$Phase;effect_result_pending=$Pending;error_type=$_.Exception.GetType().FullName;retry_permitted=$false});throw}finally{foreach($Entry in @($R.Values)){if($null-ne$Entry-and$Entry.add){try{$Entry.handle.DangerousRelease();$Entry.add=$false}catch{}}}}",
  ].join("\n");
  const protectedVariables = new Set([
    "$ErrorActionPreference", "$ProgressPreference", "$PID", "$null", "$true", "$false", "$env",
  ]);
  const variables = [...new Set(verboseSource.match(/\$[A-Za-z][A-Za-z0-9]+/gu) ?? [])]
    .filter((variable) => variable.length > 3 && !protectedVariables.has(variable))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const source = variables.reduce((result, variable, index) =>
    result.replaceAll(variable, `$S35v${index}`), verboseSource);
  if (/Vivado|hw_server|vivado_lab|open_hw|program_hw|write_cfgmem|Set-Content|Out-File/iu.test(source)
    || (source.match(/Get-CimInstance Win32_Process/gu)?.length ?? 0) !== 1
    || (source.match(/MSFT_NetTCPConnection/gu)?.length ?? 0) !== 1
    || (source.match(/\.Kill\(\)/gu)?.length ?? 0) !== 1
    || (source.match(/DangerousAddRef/gu)?.length ?? 0) !== 2) {
    throw new Error("M4F_CANDIDATE35_BUSINESS_SCRIPT_INVALID");
  }
  return source;
}

export function buildCandidate35Payload(rawConfig: unknown): Candidate35BuiltPayload {
  const businessScript = buildCandidate35BusinessScript(rawConfig);
  const compressed = gzipSync(Buffer.from(businessScript, "utf8"), { level: 9 });
  const loader = "$ErrorActionPreference='Stop';$z=[Convert]::FromBase64String('"
    + compressed.toString("base64")
    + "');$g=[IO.Compression.GZipStream]::new([IO.MemoryStream]::new($z),[IO.Compression.CompressionMode]::Decompress);&([ScriptBlock]::Create([IO.StreamReader]::new($g,[Text.UTF8Encoding]::new($false,$true)).ReadToEnd()))";
  const remoteCommand = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"& { "
    + loader + " }\"";
  if (!/^[\x00-\x7f]*$/u.test(remoteCommand) || remoteCommand.length > COMMAND_LIMIT) {
    throw new Error("M4F_CANDIDATE35_REMOTE_COMMAND_TOO_LONG");
  }
  return {
    business_script: businessScript,
    business_script_sha256: sha256(businessScript),
    business_script_length: Buffer.byteLength(businessScript, "utf8"),
    compressed_business_script: compressed,
    remote_command: remoteCommand,
    remote_command_sha256: sha256(Buffer.from(remoteCommand, "ascii")),
    remote_command_length: remoteCommand.length,
  };
}

export function planCandidate35(rawConfig: unknown) {
  const config = validateCandidate35Config(rawConfig);
  const payload = buildCandidate35Payload(config);
  return {
    schema: "synthia-m4f-direct-nine-pid-cleanup-35-plan.v1",
    cleanup_id: config.cleanup_id,
    status: "planned_not_executed",
    topology: "one_direct_ssh_empty_stdin_no_retry",
    target_order: CANDIDATE35_TARGETS.map((target) => target.pid),
    candidate31_record_sha256: config.candidate31_record_sha256,
    candidate34_record_sha256: config.candidate34_record_sha256,
    business_script_sha256: payload.business_script_sha256,
    business_script_length: payload.business_script_length,
    remote_command_sha256: payload.remote_command_sha256,
    remote_command_length: payload.remote_command_length,
    remote_command_limit: COMMAND_LIMIT,
    windows_cmd_limit: 8_191,
    windows_cmd_headroom: 8_191 - payload.remote_command_length,
    stdin_length: 0,
    remote_attempt_count: 1,
    retry_permitted: false,
    absent_target_policy: "skip",
    present_mismatch_policy: "block_all_effects",
    effect_ambiguity_policy: "permanent_partial_no_retry",
    remote_file_write_permitted: false,
    vivado_action_permitted: false,
    hardware_action_permitted: false,
  };
}

export function candidate35Confirmation(rawConfig: unknown): string {
  const config = validateCandidate35Config(rawConfig);
  const plan = planCandidate35(config);
  return ["SYNTHIA_M4F_CANDIDATE35_NINE_PID_CLEANUP", config.cleanup_id,
    sha256(canonicalJson(config) + "\n"), sha256(canonicalJson(plan) + "\n"),
    plan.business_script_sha256, plan.remote_command_sha256].join(":");
}

export function validateCandidate35MarkerPrefix(stdout: Buffer, rawConfig: unknown) {
  const config = validateCandidate35Config(rawConfig);
  const markers: Record<string, unknown>[] = [];
  let cursor = 0;
  let terminal = false;
  let awaitingResult = false;
  let stage: "start" | "preflight" | "targets" | "complete" = "start";
  let ordinal = 1;
  let presentCount = 0;
  const states = new Map<number, "present" | "absent">();
  const retainedHandles = new Map<number, string>();
  const powerResults = new Map<number, "absent" | "killed">();
  const effectHandles = new Map<number, string>();
  const utc7 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u;
  const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
    Object.keys(value).sort().join("|") === [...keys].sort().join("|");
  while (cursor < stdout.length && !terminal) {
    const newline = stdout.indexOf(0x0a, cursor);
    if (newline < 0) break;
    const end = newline > cursor && stdout[newline - 1] === 0x0d ? newline - 1 : newline;
    let marker: Record<string, unknown> | null = null;
    try { marker = object(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(stdout.subarray(cursor, end)))); }
    catch { break; }
    const payload = object(marker?.payload);
    if (!marker || !payload || !exactKeys(marker,
      ["cleanup_id", "observed_at_utc", "payload", "phase", "schema", "status"])
      || marker.schema !== "synthia-m4f-direct-nine-pid-cleanup-35-marker.v1"
      || marker.cleanup_id !== config.cleanup_id || typeof marker.phase !== "string"
      || typeof marker.observed_at_utc !== "string" || !utc7.test(marker.observed_at_utc)) break;
    if (marker.phase === "failure") {
      if (markers.length === 0 || marker.status !== "partial_unknown"
        || !exactKeys(payload, ["effect_result_pending", "error_type", "phase", "retry_permitted"])
        || payload.retry_permitted !== false || payload.effect_result_pending !== awaitingResult
        || typeof payload.phase !== "string" || payload.phase.length === 0
        || typeof payload.error_type !== "string" || payload.error_type.length === 0) break;
      terminal = true;
    } else if (stage === "start") {
      if (marker.phase !== "start" || marker.status !== "observed"
        || !exactKeys(payload, ["c31", "c34", "current_pid", "target_count"])
        || payload.target_count !== 9 || payload.c31 !== config.candidate31_record_sha256
        || payload.c34 !== config.candidate34_record_sha256
        || !Number.isSafeInteger(payload.current_pid) || Number(payload.current_pid) < 1) break;
      stage = "preflight";
    } else if (stage === "preflight") {
      const targetStates = Array.isArray(payload.target_states) ? payload.target_states : [];
      if (marker.phase !== "preflight" || marker.status !== "observed"
        || !exactKeys(payload, ["authority", "retained_count", "stale_exact",
          "target_states", "worker_retained"])
        || payload.authority !== "candidate31_historical_exact"
        || payload.stale_exact !== true || payload.worker_retained !== true
        || targetStates.length !== 9) break;
      let valid = true;
      for (let index = 0; index < 9; index += 1) {
        const item = targetStates[index];
        const target = CANDIDATE35_TARGETS[index]!;
        if (!Array.isArray(item) || item.length !== 4 || item[0] !== target.ordinal
          || item[1] !== target.pid || !["present", "absent"].includes(String(item[2]))) {
          valid = false;
          break;
        }
        states.set(target.ordinal, item[2] as "present" | "absent");
        if (item[2] === "present") {
          if (typeof item[3] !== "string" || !/^[1-9]\d*$/u.test(item[3])) {
            valid = false;
            break;
          }
          retainedHandles.set(target.ordinal, item[3]);
          presentCount += 1;
        } else if (item[3] !== null) {
          valid = false;
          break;
        }
      }
      if (!valid || payload.retained_count !== presentCount) break;
      stage = "targets";
    } else if (stage === "targets") {
      const target = CANDIDATE35_TARGETS[ordinal - 1];
      if (!target) {
        stage = "complete";
        continue;
      }
      const token = candidate35StartToken(target);
      if (states.get(ordinal) === "absent") {
        if (marker.phase !== "absent_skip" || marker.status !== "observed"
          || !exactKeys(payload, ["ordinal", "pid", "start_token"])
          || payload.ordinal !== ordinal || payload.pid !== target.pid || payload.start_token !== token) break;
        if (target.role === "powershell") powerResults.set(target.ordinal, "absent");
        ordinal += 1;
      } else if (!awaitingResult && marker.phase === "effect_start") {
        if (marker.status !== "started" || !exactKeys(payload, ["ordinal", "pid", "raw_handle", "start_token"])
          || payload.ordinal !== ordinal || payload.pid !== target.pid || payload.start_token !== token
          || typeof payload.raw_handle !== "string" || !/^[1-9]\d*$/u.test(payload.raw_handle)) break;
        if (target.role !== "powershell" && !powerResults.has((target.group - 1) * 3 + 1)) break;
        if (payload.raw_handle !== retainedHandles.get(ordinal)) break;
        effectHandles.set(ordinal, payload.raw_handle);
        awaitingResult = true;
      } else if (awaitingResult && marker.phase === "effect_result") {
        if (marker.status !== "observed"
          || !exactKeys(payload, ["effect", "has_exited", "ordinal", "pid", "raw_handle", "start_token"])
          || payload.ordinal !== ordinal || payload.pid !== target.pid || payload.start_token !== token
          || payload.raw_handle !== effectHandles.get(ordinal)
          || payload.effect !== "same_process_instance_kill_completed" || payload.has_exited !== true) break;
        if (target.role === "powershell") powerResults.set(target.ordinal, "killed");
        awaitingResult = false;
        ordinal += 1;
      } else if (!awaitingResult && marker.phase === "natural_exit") {
        const powerOrdinal = (target.group - 1) * 3 + 1;
        if (target.role === "powershell" || !powerResults.has(powerOrdinal) || marker.status !== "observed"
          || !exactKeys(payload, ["after_ordinal", "leader_resolution", "ordinal", "pid", "raw_handle", "start_token"])
          || payload.ordinal !== ordinal || payload.pid !== target.pid || payload.after_ordinal !== powerOrdinal
          || payload.leader_resolution !== powerResults.get(powerOrdinal)
          || payload.start_token !== token || typeof payload.raw_handle !== "string"
          || !/^[1-9]\d*$/u.test(payload.raw_handle)
          || payload.raw_handle !== retainedHandles.get(ordinal)) break;
        ordinal += 1;
      } else break;
      if (ordinal === 10) stage = "complete";
    } else if (stage === "complete") {
      if (marker.phase !== "complete" || marker.status !== "complete" || awaitingResult
        || !exactKeys(payload, ["absent_count", "cleanup_completed", "present_count", "retry_permitted"])
        || payload.retry_permitted !== false || payload.cleanup_completed !== true
        || payload.present_count !== presentCount || payload.absent_count !== 9 - presentCount) break;
      terminal = true;
    }
    markers.push(marker);
    cursor = newline + 1;
  }
  const validPrefix = Buffer.from(stdout.subarray(0, cursor));
  const trailing = Buffer.from(stdout.subarray(cursor));
  return {
    markers,
    valid_prefix_length: validPrefix.length,
    valid_prefix_sha256: sha256(validPrefix),
    trailing_fragment_length: trailing.length,
    trailing_fragment_sha256: sha256(trailing),
    effect_ambiguity: awaitingResult,
    complete: trailing.length === 0 && markers.at(-1)?.phase === "complete" && ordinal === 10,
    retry_permitted: false,
  };
}
