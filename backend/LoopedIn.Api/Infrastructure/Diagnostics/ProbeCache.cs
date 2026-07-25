using System.Collections.Concurrent;

namespace LoopedIn.Api.Infrastructure.Diagnostics;

/// <summary>
/// A short-lived cache for the public <c>*/ping</c> connectivity checks.
/// <para>
/// Those endpoints are unauthenticated by design — a misconfigured deployment has to be
/// diagnosable without a session — but two of them do real, billable work on every call:
/// <c>/db/ping</c> runs a query against Neon and <c>/documents/ping</c> issues an S3
/// <c>ListObjectsV2</c>. Unauthenticated work an anonymous caller can repeat is a cost
/// amplifier, bounded only by the gateway's request throttle. Caching the outcome for a few
/// seconds keeps the diagnostic value (it still reflects reality within one refresh) while
/// capping the backend calls those endpoints can generate, however hard they are hit.
/// </para>
/// <para>
/// <c>/auth/ping</c> deliberately does not use this: it reads Clerk's OIDC document through
/// the JwtBearer handler's own <c>ConfigurationManager</c>, which already caches it in memory
/// and refreshes on its own schedule, so there is no per-request outbound call to bound.
/// </para>
/// </summary>
public sealed class ProbeCache(TimeProvider? timeProvider = null)
{
    /// <summary>
    /// How long a probe result is reused. Short enough that someone fixing configuration sees
    /// the change almost immediately, long enough that a flood collapses into one backend call.
    /// </summary>
    public static readonly TimeSpan Ttl = TimeSpan.FromSeconds(10);

    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    /// <summary>
    /// Returns the cached result for <paramref name="key"/>, or runs <paramref name="probe"/>
    /// and caches it for <see cref="Ttl"/>.
    /// <para>
    /// The task is cached rather than its result, so concurrent callers arriving on a cold or
    /// expired entry share a single in-flight probe instead of each starting their own — which
    /// is the case that matters, since the traffic this guards against is concurrent by nature.
    /// A probe that answers "unavailable" is cached like any other: a failing dependency is
    /// exactly what should not be re-hammered. Probes are expected to return a result rather
    /// than throw (the endpoints catch their own exceptions); a thrown one would be cached as a
    /// faulted task for the TTL and rethrown to each caller.
    /// </para>
    /// </summary>
    public Task<IResult> GetOrProbeAsync(string key, Func<Task<IResult>> probe)
    {
        var now = _timeProvider.GetUtcNow();

        var entry = _entries.AddOrUpdate(
            key,
            // Both factories may run more than once under contention, so they must stay free of
            // side effects — hence Lazy: creating one is cheap and starts nothing. Only the
            // entry that actually wins the dictionary has its Value read, so the probe runs once.
            _ => NewEntry(now, probe),
            (_, existing) => existing.ExpiresAt > now ? existing : NewEntry(now, probe));

        return entry.Probe.Value;
    }

    private Entry NewEntry(DateTimeOffset now, Func<Task<IResult>> probe) =>
        new(now + Ttl, new Lazy<Task<IResult>>(probe, LazyThreadSafetyMode.ExecutionAndPublication));

    private sealed record Entry(DateTimeOffset ExpiresAt, Lazy<Task<IResult>> Probe);
}
