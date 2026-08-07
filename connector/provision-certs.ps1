$ErrorActionPreference = "Stop"
$root = "D:\synthia-worker"
New-Item -ItemType Directory -Force $root | Out-Null
$password = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
Set-Content -Path "$root\pfx-password.txt" -Value $password -NoNewline
icacls "$root\pfx-password.txt" /inheritance:r /grant:r "$env:USERNAME:(R,W)" | Out-Null
$secure = ConvertTo-SecureString $password -AsPlainText -Force
$ca = New-SelfSignedCertificate -Subject "CN=Synthia Worker CA 66" -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -CertStoreLocation Cert:\CurrentUser\My -KeyUsage CertSign,CRLSign,DigitalSignature -TextExtension @("2.5.29.19={text}CA=true")
Export-Certificate -Cert $ca -FilePath "$root\client-ca.cer" | Out-Null
$server = New-SelfSignedCertificate -Subject "CN=DESKTOP-DVFFB09" -Signer $ca -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -CertStoreLocation Cert:\CurrentUser\My -DnsName "192.168.31.66","DESKTOP-DVFFB09" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.1")
Export-PfxCertificate -Cert $server -FilePath "$root\server.pfx" -Password $secure | Out-Null
$client = New-SelfSignedCertificate -Subject "CN=Synthia Core Client" -Signer $ca -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable -CertStoreLocation Cert:\CurrentUser\My -DnsName "synthia-core" -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.2")
Export-PfxCertificate -Cert $client -FilePath "$root\client.pfx" -Password $secure | Out-Null
Write-Output "CERT_PROVISIONED"
Write-Output "CA_FINGERPRINT=$((Get-FileHash "$root\client-ca.cer" -Algorithm SHA256).Hash)"
Write-Output "SERVER_FINGERPRINT=$((Get-PfxCertificate "$root\server.pfx").Thumbprint)"
Write-Output "CLIENT_FINGERPRINT=$((Get-PfxCertificate "$root\client.pfx").Thumbprint)"
