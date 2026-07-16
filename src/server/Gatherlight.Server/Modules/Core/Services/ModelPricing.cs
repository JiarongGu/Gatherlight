namespace Gatherlight.Server.Modules.Core.Services;

/// <summary>
/// Per-model token pricing (USD per 1M tokens). The single source of truth for turning a run's token
/// counts into a realistic dollar cost — computed from the ACTUAL model that ran, instead of trusting
/// the claude CLI's opaque <c>total_cost_usd</c> (which reflects whatever the CLI decided and isn't
/// tied to our model routing). Consumed by <c>ClaudeCliRunner</c> (the 'usage' event cost, which chat
/// and Trace both read) and by the KB merge card's live per-file cost. Rates are Anthropic public list
/// prices (cached 2026-06); update the table here when they change.
/// </summary>
public static class ModelPricing
{
    // (name fragment, input $/MTok, output $/MTok). Matched case-insensitively as a substring so both
    // short names ("sonnet") and full ids ("claude-sonnet-4-6-20251114") resolve to the same tier.
    private static readonly (string Key, double In, double Out)[] Table =
    {
        ("fable",  10.0, 50.0),
        ("haiku",   1.0,  5.0),
        ("sonnet",  3.0, 15.0),
        ("opus",    5.0, 25.0),
    };

    // Cache-read input is ~0.1x base input. Cache writes are billed by TTL: 1.25x (5-minute) or 2x
    // (1-hour). The claude CLI manages its own cache TTL and doesn't report which it used, so we assume
    // the 5-minute default; a 1-hour-cached call therefore under-reports its (usually tiny) write cost.
    private const double CacheReadFactor = 0.10;
    private const double CacheWriteFactor = 1.25;

    // Fallback tier when the model is unknown/blank — Opus is the app's default chat model.
    private static readonly (double In, double Out) DefaultRate = (5.0, 25.0);

    /// <summary>USD cost for one run's usage. Unknown/blank model → Opus rates (the default tier).</summary>
    public static double CostUsd(string? model, long inputTokens, long outputTokens,
        long cacheReadTokens = 0, long cacheCreationTokens = 0)
    {
        var (inRate, outRate) = RatesFor(model);
        var cost =
            inputTokens * inRate +
            outputTokens * outRate +
            cacheReadTokens * inRate * CacheReadFactor +
            cacheCreationTokens * inRate * CacheWriteFactor;
        return cost / 1_000_000d;
    }

    private static (double In, double Out) RatesFor(string? model)
    {
        if (string.IsNullOrWhiteSpace(model)) return DefaultRate;
        var m = model.ToLowerInvariant();
        foreach (var (key, inRate, outRate) in Table)
            if (m.Contains(key)) return (inRate, outRate);
        return DefaultRate;
    }
}
