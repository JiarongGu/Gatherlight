using Gatherlight.Server.Platform.Kernel.Services;
using Lyntai.Memory.Annotation;
using Lyntai.Memory.Verification;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// The live on/off for the claude-CLI memory enrichment.
///
/// <para><b>Why a switch here rather than a registration.</b> Whether the enrichment runs is a
/// dynamic, tunable value, and this codebase already says where those belong: <c>ServerConfig</c>'s own
/// doc reserves <c>settings.json</c> for "what must exist before the DB opens", with everything tunable in
/// <c>app_config</c> — which is what the cortex panel edits. The enrichment's MODEL already lives there
/// (<c>llm.model.memory</c>); having its on/off somewhere else, behind a restart, split one feature's
/// controls across two stores.</para>
///
/// <para><b>Why decorating works at all.</b> Both seams already define a "no opinion" result that the
/// engine treats as identical to having no policy registered — <see cref="MemoryAnnotation.None"/> and
/// <see cref="MemoryVerification.NoOpinion"/>. So "off" is not a new code path to be got right; it is a
/// state the library already handles, and one a model outage produces anyway. That is what makes the
/// switch safe to flip at runtime rather than at startup.</para>
///
/// <para>Default ON when unset: the enrichment shipped on with the Lyntai 3.0 adoption, and defaulting it
/// off would silently degrade recall for every existing household on upgrade.</para>
/// </summary>
public static class MemoryEnrichment
{
    /// <summary>app_config key. Absent = on; "0" = off.</summary>
    public const string Key = "memory.enrichment.enabled";

    public static bool IsOn(IAppConfigService config) => config.Get(Key) != "0";

    public static void Set(IAppConfigService config, bool on)
    {
        if (on) config.Delete(Key);      // absent = the default, so "on" leaves no row behind
        else config.Set(Key, "0");
    }
}

/// <summary>Runs the real annotator only while the switch is on. Registered BEFORE
/// <c>AddMemoryAnnotation()</c>, whose <c>TryAddSingleton</c> then stands down — the BYO seam that
/// registration documents.</summary>
public sealed class SwitchableAnnotationPolicy : IMemoryAnnotationPolicy
{
    private readonly IMemoryAnnotationPolicy _inner;
    private readonly IAppConfigService _config;

    public SwitchableAnnotationPolicy(IMemoryAnnotationPolicy inner, IAppConfigService config)
    {
        _inner = inner;
        _config = config;
    }

    public Task<MemoryAnnotation> AnnotateAsync(MemoryAnnotationRequest request, CancellationToken ct = default)
        // Read per call, not cached: the point of moving this out of settings.json was that it takes
        // effect without a restart.
        => MemoryEnrichment.IsOn(_config)
            ? _inner.AnnotateAsync(request, ct)
            : Task.FromResult(MemoryAnnotation.None);
}

/// <summary>Runs the real verifier only while the switch is on. Off returns
/// <see cref="MemoryVerification.NoOpinion"/> — "could not decide", which the engine reinforces normally
/// for. Deliberately NOT <see cref="MemoryVerification.NothingRelevant"/>: that would assert every recall
/// found nothing useful and teach the engine exactly the wrong thing.</summary>
public sealed class SwitchableVerificationPolicy : IMemoryVerificationPolicy
{
    private readonly IMemoryVerificationPolicy _inner;
    private readonly IAppConfigService _config;

    public SwitchableVerificationPolicy(IMemoryVerificationPolicy inner, IAppConfigService config)
    {
        _inner = inner;
        _config = config;
    }

    public Task<MemoryVerification> VerifyAsync(MemoryVerificationRequest request, CancellationToken ct = default)
        => MemoryEnrichment.IsOn(_config)
            ? _inner.VerifyAsync(request, ct)
            : Task.FromResult(MemoryVerification.NoOpinion);
}
