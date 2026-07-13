using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Gatherlight.Server.Modules.Security.Services;

/// <summary>
/// Resolves the certificate Kestrel serves HTTPS with, at host-build time (before the DI container
/// exists). Priority: a configured PFX (<c>security.tls.certPath</c>) → a self-signed certificate
/// generated once and persisted to <c>{data}/state/gatherlight-tls.pfx</c>. The self-signed cert
/// gives real transport encryption (the access token isn't sent in the clear) but is untrusted, so
/// browsers warn — swap in a CA-issued cert to remove the warning.
/// </summary>
public static class TlsCertificate
{
    public const string SelfSignedFileName = "gatherlight-tls.pfx";

    /// <summary>The cert to bind, or null when TLS is disabled.</summary>
    public static X509Certificate2? Resolve(GatherlightServerOptions options)
    {
        if (!options.TlsEnabled) return null;

        if (!string.IsNullOrWhiteSpace(options.TlsCertPath))
        {
            if (!File.Exists(options.TlsCertPath))
                throw new FileNotFoundException($"TLS certificate not found: {options.TlsCertPath}");
            return X509CertificateLoader.LoadPkcs12FromFile(options.TlsCertPath, options.TlsCertPassword);
        }

        var stateDir = Path.Combine(Path.GetFullPath(options.DataPath), "state");
        Directory.CreateDirectory(stateDir);
        var pfxPath = Path.Combine(stateDir, SelfSignedFileName);

        if (File.Exists(pfxPath))
        {
            try { return X509CertificateLoader.LoadPkcs12FromFile(pfxPath, null); }
            catch { /* unreadable/corrupt → regenerate below */ }
        }

        var pfx = GenerateSelfSigned(options.BindAddress);
        File.WriteAllBytes(pfxPath, pfx);
        return X509CertificateLoader.LoadPkcs12(pfx, null);
    }

    private static byte[] GenerateSelfSigned(string bindAddress)
    {
        using var rsa = RSA.Create(2048);
        var req = new CertificateRequest("CN=Gatherlight", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        req.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, critical: true));
        // serverAuth EKU (1.3.6.1.5.5.7.3.1) — required for TLS server certificates.
        req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(
            new OidCollection { new Oid("1.3.6.1.5.5.7.3.1") }, critical: false));

        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("localhost");
        if (!string.IsNullOrWhiteSpace(Environment.MachineName)) san.AddDnsName(Environment.MachineName);
        san.AddIpAddress(IPAddress.Loopback);
        san.AddIpAddress(IPAddress.IPv6Loopback);
        if (IPAddress.TryParse(bindAddress, out var bindIp) && !bindIp.Equals(IPAddress.Any) && !bindIp.Equals(IPAddress.IPv6Any))
            san.AddIpAddress(bindIp);
        req.CertificateExtensions.Add(san.Build());

        using var cert = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(5));
        return cert.Export(X509ContentType.Pfx);
    }
}
