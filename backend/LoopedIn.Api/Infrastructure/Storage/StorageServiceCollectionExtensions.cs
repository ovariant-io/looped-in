using Amazon.S3;

namespace LoopedIn.Api.Infrastructure.Storage;

/// <summary>
/// Composable DI registrations for S3-backed document storage.
/// </summary>
public static class StorageServiceCollectionExtensions
{
    /// <summary>
    /// Registers the S3 client and <see cref="DocumentStore"/> when <c>Documents:Bucket</c> is
    /// configured. When it is not — or when the AWS SDK cannot resolve a region — the store is
    /// left unregistered and a <see cref="DocumentStorageStatus"/> carrying the reason is
    /// registered instead, so the app still boots and <c>GET /documents/ping</c> can explain
    /// itself. This mirrors how <c>AddNeonDatabase</c> and <c>AddClerkAuthentication</c> degrade.
    /// <para>
    /// Credentials and region come from the standard AWS chain (<c>AWS_REGION</c>, environment
    /// credentials, <c>~/.aws</c> profiles, and on Lambda the execution role) — this app holds no
    /// AWS keys of its own in configuration.
    /// </para>
    /// </summary>
    public static IServiceCollection AddDocumentStorage(this IServiceCollection services, IConfiguration configuration)
    {
        var bucket = configuration[$"{DocumentStorageOptions.SectionName}:Bucket"]?.Trim();
        var prefix = DocumentKey.NormalizePrefix(configuration[$"{DocumentStorageOptions.SectionName}:Prefix"]);

        if (string.IsNullOrWhiteSpace(bucket))
        {
            return services.AddSingleton(new DocumentStorageStatus(
                Configured: false,
                Bucket: null,
                Prefix: prefix,
                Reason: "Documents:Bucket is not configured. Set Documents__Bucket in backend/.env.local "
                    + "(see .env.local.example) to an S3 bucket name, or deploy the stack, which passes it in."));
        }

        IAmazonS3 client;
        try
        {
            // Region and credentials resolve from the ambient AWS chain. This throws when no
            // region can be found anywhere, which is the common local-dev misconfiguration.
            client = new AmazonS3Client();
        }
        catch (Exception ex)
        {
            // No ILogger is resolvable at registration time; use a throwaway bootstrap logger.
            using var loggerFactory = LoggerFactory.Create(builder => builder.AddConsole());
            loggerFactory.CreateLogger("LoopedIn.Api.Storage").LogWarning(
                "Document storage is unavailable: the AWS S3 client could not be created ({Reason}). "
                    + "Document endpoints will report 503 until this is resolved — usually by setting AWS_REGION.",
                ex.Message);

            return services.AddSingleton(new DocumentStorageStatus(
                Configured: false,
                Bucket: bucket,
                Prefix: prefix,
                Reason: $"The AWS S3 client could not be created: {ex.Message}. Set AWS_REGION (and credentials) "
                    + "in backend/.env.local, or configure an AWS profile."));
        }

        var options = new DocumentStorageOptions { Bucket = bucket, Prefix = prefix };

        services.AddSingleton(options);
        services.AddSingleton(client);
        services.AddSingleton<DocumentStore>();
        services.AddSingleton(new DocumentStorageStatus(
            Configured: true,
            Bucket: options.Bucket,
            Prefix: options.Prefix,
            Reason: null));

        return services;
    }
}
