# judge-bench — what each way of judging a recall is worth

Measured with `node devtools/dev.mjs judge-bench` on `devtools/fixtures/recall-bilingual.json` (60 invented
facts incl. near-duplicate clusters; four questions each: same / cross / third language / code-switched),
`limit 8`, one snapshot per arm. Date, claude CLI version, and the exact command go in each run's heading.

The 语义 (semantic) layer was OFF in every arm below — this run measures 判断 (the judge) alone. Cross-language
recall therefore had no semantic channel to bridge languages; only the lexical floor (公式) and the judge's own
reasoning over candidate text carried it, which is why every arm's cross/third-language numbers stay far below
its same-language numbers (see "What it does NOT say").

## Run 1 — the Claude judge (2026-09-23, claude 2.1.280)

**Command**

```
node devtools/dev.mjs judge-bench --reuse-seed --arms=formula,formula2,topic,content,content2,contentonly,fuse \
  > devtools/_judge-bench-cli.txt 2>&1

node devtools/dev.mjs judge-bench --report-only=devtools/_judge-bench/results-2026-09-23T091740.681Z.json \
  > devtools/_judge-bench-cli-reanalysed.txt 2>&1
```

**Seed** — reused (not reseeded): created 2026-09-23T08:55:21.396Z, annotated by claude `2.1.280 (Claude Code)`,
fixture sha256 `9680443e206495ca8bcd067f80f4705cff5e31a365504fbac438413002ecf555` (the run's own fixture hash
matches it — same fixture). The seed's own app HEAD/version are unrecorded (the seed predates that field); this
run's app HEAD is `81e3ddd` (v1.2.0). Order seed **12345** (240 queries, 0 same-fact adjacencies), concurrency
**7 arms in parallel**, latency sample 12 queries. Formula positions digest **`f661eb6a056e`** (240 queries, 60
facts) — the precondition for treating every arm as having started from the same graph.

### Accuracy — the four sets and `all`

```
== same ==
arm                                                    n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)             60   0    60     0       0         42/60     54/60     0.769   301            
公式 · no verification · A/A twin                      60   0    60     0       0         42/60     54/60     0.769   310            +0 / +0 / +0.000
Claude judge · topic only                              60   0    60     60      42        53/60     57/60     0.912   14249          +11 / +3 / +0.143
Claude judge · topic — content · partition             60   0    60     59      56        57/60     57/60     0.950   14434          +15 / +3 / +0.181
Claude judge · topic — content · partition · A/A twin  60   0    60     60      57        57/60     57/60     0.950   14483          +15 / +3 / +0.181
Claude judge · content only · partition                60   0    60     60      57        57/60     57/60     0.950   14357          +15 / +3 / +0.181
Claude judge · topic — content · fuse                  60   0    60     59      56        28/60     56/60     0.656   13998          -14 / +2 / -0.113

== cross ==
arm                                                    n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)             60   0    60     0       0         1/60      6/60      0.042   369            
公式 · no verification · A/A twin                      60   0    60     0       0         1/60      6/60      0.042   368            +0 / +0 / +0.000
Claude judge · topic only                              60   0    60     60      9         9/60      9/60      0.150   15500          +8 / +3 / +0.108
Claude judge · topic — content · partition             60   0    60     60      11        11/60     11/60     0.183   15540          +10 / +5 / +0.142
Claude judge · topic — content · partition · A/A twin  60   0    60     60      9         9/60      9/60      0.150   15357          +8 / +3 / +0.108
Claude judge · content only · partition                60   0    60     60      9         9/60      9/60      0.150   15880          +8 / +3 / +0.108
Claude judge · topic — content · fuse                  60   0    60     60      9         1/60      7/60      0.042   15671          +0 / +1 / +0.001

== third ==
arm                                                    n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)             60   0    55     0       0         1/60      18/60     0.119   318            
公式 · no verification · A/A twin                      60   0    55     0       0         1/60      18/60     0.119   319            +0 / +0 / +0.000
Claude judge · topic only                              60   0    55     54      12        12/60     16/60     0.233   13165          +11 / -2 / +0.114
Claude judge · topic — content · partition             60   0    55     55      16        16/60     16/60     0.267   13768          +15 / -2 / +0.147
Claude judge · topic — content · partition · A/A twin  60   0    55     55      16        16/60     16/60     0.267   14173          +15 / -2 / +0.147
Claude judge · content only · partition                60   0    55     54      16        16/60     16/60     0.267   13757          +15 / -2 / +0.147
Claude judge · topic — content · fuse                  60   0    55     55      16        1/60      16/60     0.138   14642          +0 / -2 / +0.018

== mixed ==
arm                                                    n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)             60   0    59     0       0         35/60     47/60     0.657   359            
公式 · no verification · A/A twin                      60   0    59     0       0         35/60     47/60     0.657   361            +0 / +0 / +0.000
Claude judge · topic only                              60   0    59     59      39        46/60     49/60     0.792   14634          +11 / +2 / +0.135
Claude judge · topic — content · partition             60   0    59     57      46        48/60     49/60     0.808   15065          +13 / +2 / +0.151
Claude judge · topic — content · partition · A/A twin  60   0    59     59      48        48/60     49/60     0.808   14564          +13 / +2 / +0.151
Claude judge · content only · partition                60   0    59     59      48        48/60     49/60     0.808   14852          +13 / +2 / +0.151
Claude judge · topic — content · fuse                  60   0    59     59      48        33/60     49/60     0.678   14526          -2 / +2 / +0.021

== all ==
arm                                                    n    err  graph  judged  endorsed  top-1     found@8   MRR     ms (parallel)  Δ vs 公式 (top-1 / found / MRR)
公式 · no verification (seed tags present)             240  0    234    0       0         79/240    125/240   0.397   337            
公式 · no verification · A/A twin                      240  0    234    0       0         79/240    125/240   0.397   339            +0 / +0 / +0.000
Claude judge · topic only                              240  0    234    233     102       120/240   131/240   0.522   14387          +41 / +6 / +0.125
Claude judge · topic — content · partition             240  0    234    231     129       132/240   133/240   0.552   14702          +53 / +8 / +0.155
Claude judge · topic — content · partition · A/A twin  240  0    234    234     130       130/240   131/240   0.544   14644          +51 / +6 / +0.147
Claude judge · content only · partition                240  0    234    233     130       130/240   131/240   0.544   14712          +51 / +6 / +0.147
Claude judge · topic — content · fuse                  240  0    234    233     129       63/240    128/240   0.378   14709          -16 / +3 / -0.018
```

### Paired vs `content` — McNemar exact, per query

`b` = content hit & arm miss, `c` = content miss & arm hit. Interval = Agresti–Min 95% for the net rate
`(c − b) / pairs`; equivalence needs the whole interval inside ±3pp.

```
  top-1:
  arm                                                    set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification (seed tags present)             all     240    53/0     <0.001  -53 (-22.1pp)    [-27.2, -16.6]pp    no          YES (arm worse)
                                                         same    60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                         cross   60     10/0     0.002   -10 (-16.7pp)    [-25.8, -6.4]pp     —           
                                                         third   60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                         mixed   60     13/0     <0.001  -13 (-21.7pp)    [-31.6, -10.4]pp    —           
  公式 · no verification · A/A twin                      all     240    53/0     <0.001  -53 (-22.1pp)    [-27.2, -16.6]pp    no          YES (arm worse)
                                                         same    60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                         cross   60     10/0     0.002   -10 (-16.7pp)    [-25.8, -6.4]pp     —           
                                                         third   60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                         mixed   60     13/0     <0.001  -13 (-21.7pp)    [-31.6, -10.4]pp    —           
  Claude judge · topic only                              all     240    12/0     <0.001  -12 (-5.0pp)     [-7.8, -2.1]pp      no          YES (arm worse)
                                                         same    60     4/0      0.125   -4 (-6.7pp)      [-13.3, +0.4]pp     —           
                                                         cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         third   60     4/0      0.125   -4 (-6.7pp)      [-13.3, +0.4]pp     —           
                                                         mixed   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
  Claude judge · topic — content · partition · A/A twin  all     240    2/0      0.500   -2 (-0.8pp)      [-2.2, +0.6]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · content only · partition                all     240    2/0      0.500   -2 (-0.8pp)      [-2.2, +0.6]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · topic — content · fuse                  all     240    69/0     <0.001  -69 (-28.8pp)    [-34.3, -22.8]pp    no          YES (arm worse)
                                                         same    60     29/0     <0.001  -29 (-48.3pp)    [-59.6, -34.0]pp    —           
                                                         cross   60     10/0     0.002   -10 (-16.7pp)    [-25.8, -6.4]pp     —           
                                                         third   60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
                                                         mixed   60     15/0     <0.001  -15 (-25.0pp)    [-35.3, -13.1]pp    —           
  found@8:
  arm                                                    set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification (seed tags present)             all     240    13/5     0.096   -8 (-3.3pp)      [-6.8, +0.2]pp      no          no
                                                         same    60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —           
                                                         cross   60     8/3      0.227   -5 (-8.3pp)      [-18.8, +2.7]pp     —           
                                                         third   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
                                                         mixed   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
  公式 · no verification · A/A twin                      all     240    13/5     0.096   -8 (-3.3pp)      [-6.8, +0.2]pp      no          no
                                                         same    60     3/0      0.250   -3 (-5.0pp)      [-11.0, +1.4]pp     —           
                                                         cross   60     8/3      0.227   -5 (-8.3pp)      [-18.8, +2.7]pp     —           
                                                         third   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
                                                         mixed   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
  Claude judge · topic only                              all     240    2/0      0.500   -2 (-0.8pp)      [-2.2, +0.6]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · topic — content · partition · A/A twin  all     240    2/0      0.500   -2 (-0.8pp)      [-2.2, +0.6]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · content only · partition                all     240    2/0      0.500   -2 (-0.8pp)      [-2.2, +0.6]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · topic — content · fuse                  all     240    5/0      0.063   -5 (-2.1pp)      [-4.0, -0.1]pp      no          no
                                                         same    60     1/0      1.000   -1 (-1.7pp)      [-6.1, +2.8]pp      —           
                                                         cross   60     4/0      0.125   -4 (-6.7pp)      [-13.3, +0.4]pp     —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
```

### Paired vs `formula` — McNemar exact, per query

`b` = formula hit & arm miss, `c` = formula miss & arm hit.

```
  top-1:
  arm                                                    set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification · A/A twin                      all     240    0/0      1.000   +0 (+0.0pp)      [-0.8, +0.8]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · topic only                              all     240    4/45     <0.001  +41 (+17.1pp)    [+11.6, +22.3]pp    no          YES (arm better)
                                                         same    60     3/14     0.013   +11 (+18.3pp)    [+5.1, +30.4]pp     —           
                                                         cross   60     0/8      0.008   +8 (+13.3pp)     [+4.0, +21.8]pp     —           
                                                         third   60     0/11     <0.001  +11 (+18.3pp)    [+7.7, +27.8]pp     —           
                                                         mixed   60     1/12     0.003   +11 (+18.3pp)    [+6.8, +28.7]pp     —           
  Claude judge · topic — content · partition             all     240    0/53     <0.001  +53 (+22.1pp)    [+16.6, +27.2]pp    no          YES (arm better)
                                                         same    60     0/15     <0.001  +15 (+25.0pp)    [+13.1, +35.3]pp    —           
                                                         cross   60     0/10     0.002   +10 (+16.7pp)    [+6.4, +25.8]pp     —           
                                                         third   60     0/15     <0.001  +15 (+25.0pp)    [+13.1, +35.3]pp    —           
                                                         mixed   60     0/13     <0.001  +13 (+21.7pp)    [+10.4, +31.6]pp    —           
  Claude judge · topic — content · partition · A/A twin  all     240    0/51     <0.001  +51 (+21.3pp)    [+15.9, +26.3]pp    no          YES (arm better)
                                                         same    60     0/15     <0.001  +15 (+25.0pp)    [+13.1, +35.3]pp    —           
                                                         cross   60     0/8      0.008   +8 (+13.3pp)     [+4.0, +21.8]pp     —           
                                                         third   60     0/15     <0.001  +15 (+25.0pp)    [+13.1, +35.3]pp    —           
                                                         mixed   60     0/13     <0.001  +13 (+21.7pp)    [+10.4, +31.6]pp    —           
  Claude judge · content only · partition                all     240    0/51     <0.001  +51 (+21.3pp)    [+15.9, +26.3]pp    no          YES (arm better)
                                                         same    60     0/15     <0.001  +15 (+25.0pp)    [+13.1, +35.3]pp    —           
                                                         cross   60     0/8      0.008   +8 (+13.3pp)     [+4.0, +21.8]pp     —           
                                                         third   60     0/15     <0.001  +15 (+25.0pp)    [+13.1, +35.3]pp    —           
                                                         mixed   60     0/13     <0.001  +13 (+21.7pp)    [+10.4, +31.6]pp    —           
  Claude judge · topic — content · fuse                  all     240    18/2     <0.001  -16 (-6.7pp)     [-10.2, -3.0]pp     no          YES (arm worse)
                                                         same    60     15/1     <0.001  -14 (-23.3pp)    [-34.3, -10.8]pp    —           
                                                         cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     3/1      0.625   -2 (-3.3pp)      [-10.2, +3.8]pp     —           
  found@8:
  arm                                                    set     pairs  b/c      p       net c−b          95% net interval    equiv ±3pp  finding
  公式 · no verification · A/A twin                      all     240    0/0      1.000   +0 (+0.0pp)      [-0.8, +0.8]pp      YES         no
                                                         same    60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         cross   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         third   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
                                                         mixed   60     0/0      1.000   +0 (+0.0pp)      [-3.2, +3.2]pp      —           
  Claude judge · topic only                              all     240    5/11     0.210   +6 (+2.5pp)      [-0.8, +5.8]pp      no          no
                                                         same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
                                                         cross   60     3/6      0.508   +3 (+5.0pp)      [-5.1, +14.8]pp     —           
                                                         third   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
  Claude judge · topic — content · partition             all     240    5/13     0.096   +8 (+3.3pp)      [-0.2, +6.8]pp      no          no
                                                         same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
                                                         cross   60     3/8      0.227   +5 (+8.3pp)      [-2.7, +18.8]pp     —           
                                                         third   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
  Claude judge · topic — content · partition · A/A twin  all     240    5/11     0.210   +6 (+2.5pp)      [-0.8, +5.8]pp      no          no
                                                         same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
                                                         cross   60     3/6      0.508   +3 (+5.0pp)      [-5.1, +14.8]pp     —           
                                                         third   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
  Claude judge · content only · partition                all     240    5/11     0.210   +6 (+2.5pp)      [-0.8, +5.8]pp      no          no
                                                         same    60     0/3      0.250   +3 (+5.0pp)      [-1.4, +11.0]pp     —           
                                                         cross   60     3/6      0.508   +3 (+5.0pp)      [-5.1, +14.8]pp     —           
                                                         third   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
  Claude judge · topic — content · fuse                  all     240    6/9      0.607   +3 (+1.3pp)      [-2.0, +4.5]pp      no          no
                                                         same    60     1/3      0.625   +2 (+3.3pp)      [-3.8, +10.2]pp     —           
                                                         cross   60     3/4      1.000   +1 (+1.7pp)      [-7.3, +10.5]pp     —           
                                                         third   60     2/0      0.500   -2 (-3.3pp)      [-8.6, +2.2]pp      —           
                                                         mixed   60     0/2      0.500   +2 (+3.3pp)      [-2.2, +8.6]pp      —           
```

### A/A sanity check

```
A/A SANITY CHECK — each pair ran the identical configuration from the identical snapshot, so its p on `all`
must stay ≥ 0.05; if it does not, the paired test is seeing something that is not there and the run is suspect.

formula vs formula2 (engine — no model in the loop):   Δ top-1 / found / MRR   ·   paired p (top-1, found@8)
  same    +0 / +0 / +0.000           ·   p 1.000, 1.000
  cross   +0 / +0 / +0.000           ·   p 1.000, 1.000
  third   +0 / +0 / +0.000           ·   p 1.000, 1.000
  mixed   +0 / +0 / +0.000           ·   p 1.000, 1.000
  all     +0 / +0 / +0.000           ·   p 1.000, 1.000

content vs content2 (judge — the LLM's verdicts vary run to run):   Δ top-1 / found / MRR   ·   paired p (top-1, found@8)
  same    +0 / +0 / +0.000           ·   p 1.000, 1.000
  cross   -2 / -2 / -0.033           ·   p 0.500, 0.500
  third   +0 / +0 / +0.000           ·   p 1.000, 1.000
  mixed   +0 / +0 / +0.000           ·   p 1.000, 1.000
  all     -2 / -2 / -0.008           ·   p 0.500, 0.500
```

Both A/A pairs stay at p ≥ 0.05 on `all`, so the run passes its own sanity check. `formula`/`formula2` are
byte-identical everywhere (no model in the loop — expected). `content`/`content2` differ by exactly 2 queries,
both in the `cross` set (p = 0.500) — the LLM judge's verdicts are not perfectly reproducible run to run, and
this is the size of that noise on 240 paired queries (see "What it does NOT say").

### Latency and candidate-text size

```
latency (ms) — parallel: mean over the accuracy pass, 7 arm(s) at once; serial median: one arm at a time, first 12 queries, judge arms counting only recalls that carried a verdict
arm                                                    ms (parallel)  ms (serial median)  cli ok/failed (accuracy)  cli ok/failed (total)  judge
公式 · no verification (seed tags present)             337            211                 0/0                       0/0                    off · claude-cli · haiku
公式 · no verification · A/A twin                      339            226                 0/0                       0/0                    off · claude-cli · haiku
Claude judge · topic only                              14387          11722               233/1                     245/1                  on · claude-cli · haiku
Claude judge · topic — content · partition             14702          9531                231/3                     243/3                  on · claude-cli · haiku
Claude judge · topic — content · partition · A/A twin  14644          8969                234/0                     246/0                  on · claude-cli · haiku
Claude judge · content only · partition                14712          8733                233/1                     245/1                  on · claude-cli · haiku
Claude judge · topic — content · fuse                  14709          9033                233/1                     245/1                  on · claude-cli · haiku

candidate text per recall (estimated; 60 candidates at most — the engine gathers only what matches or links; numbering, instructions and the query are excluded, and chars ≠ tokens):
  Claude judge · topic only                              up to ~609 chars (10 per candidate)
  Claude judge · topic — content · partition             up to ~3306 chars (55 per candidate)
  Claude judge · topic — content · partition · A/A twin  up to ~3306 chars (55 per candidate)
  Claude judge · content only · partition                up to ~2517 chars (42 per candidate)
  Claude judge · topic — content · fuse                  up to ~3306 chars (55 per candidate)
```

### Warnings

```
WARNING: arm topic — 1 claude-cli call(s) failed during the accuracy pass
WARNING: arm content — 3 claude-cli call(s) failed during the accuracy pass
WARNING: arm contentonly — 1 claude-cli call(s) failed during the accuracy pass
WARNING: arm fuse — 1 claude-cli call(s) failed during the accuracy pass
```

No `judge failed open` warning fired for any arm (see the CLI-failures bullet below for why).

### What it says

- **Judge vs 公式, by set.** `content` (topic — content · partition) is the strongest arm against the no-verification
  baseline: on `all`, top-1 moves from 79/240 to 132/240 — paired vs formula 0/53, p < 0.001, net +53 = **+22.1pp**,
  95% CI **[+16.6, +27.2]pp** (finding: arm better) — and every per-set top-1 comparison agrees in direction and is
  itself significant (same +25.0pp p<.001, cross +16.7pp p=.002, third +25.0pp p<.001, mixed +21.7pp p<.001), so
  nothing in the per-set tables contradicts the `all` finding. found@8 moves from 125/240 to 133/240 but is **not**
  a finding (net +8 = +3.3pp, 95% CI [-0.2, +6.8]pp, p = 0.096 — just short of 0.05). `topic`-only also beats
  formula on top-1 (net +41 = +17.1pp, 95% CI [+11.6, +22.3]pp, p < 0.001, same direction in all four sets) but by
  less than `content`, and likewise does not reach a found@8 finding (net +6 = +2.5pp, 95% CI [-0.8, +5.8]pp,
  p = 0.210). `fuse` is the one judge configuration that **loses** to formula on top-1: net -16 = **-6.7pp**,
  95% CI [-10.2, -3.0]pp, p < 0.001 (finding: arm worse) — driven almost entirely by the same-language set
  (-23.3pp, p < 0.001), where fuse scores only 28/60 against formula's own 42/60. Fusing the two verdicts makes the
  judge worse than running no judge at all on the easiest set.
- **topic-only vs content — is the fix confirmed?** Yes, on top-1: `content` beats `topic`-only (paired vs content:
  12/0, p < 0.001, net -12 = **-5.0pp** in content's favor, 95% CI [-7.8, -2.1]pp, not equivalent — finding: topic-only
  worse). No per-set comparison runs opposite (same 4/0 p=.125, cross 2/0 p=.500, third 4/0 p=.125, mixed 2/0
  p=.500 — none individually significant, none in the opposite direction), so the `all` finding stands under the
  paired-test rule. On found@8 the two are **equivalent** (2/0, net -0.8pp, 95% CI [-2.2, +0.6]pp, inside ±3pp):
  whichever text the judge sees, the right fact still lands somewhere in the top 8 — showing content changes only
  which one gets ranked first.
- **topic — content (partition) vs content only — equivalence verdict, and the ContentChars decision.**
  Equivalent on both metrics: top-1 net -0.8pp (2/0, p = 0.500, 95% CI [-2.2, +0.6]pp, inside ±3pp) and found@8
  the same (2/0, p = 0.500, 95% CI [-2.2, +0.6]pp). Per set the two arms are identical on same/third/mixed (0/0
  pairs, p = 1.000) and differ only on `cross` (2/0, p = 0.500, not significant). Latency and candidate size both
  favor dropping the topic prefix: content-only's serial median is 8733 ms against partition's 9531 ms, and its
  estimated candidate text tops out at ~2517 chars (42/candidate) against partition's ~3306 chars (55/candidate) —
  about 24% smaller, for a result the paired test cannot tell apart from partition's. Applying the plan's decision
  rule literally: the equivalence holds on `all`, so **the topic prefix does not earn its tokens** — when Lyntai
  ships `LlmVerificationOptions.ContentChars` (content alone; task-archive Part 276 / D170), the `JudgeSeesContentPolicy`
  topic-prefix decorator should be deleted in favor of it.
- **topic — content (partition) vs fuse — does fuse change the default?** No. Against `content`, `fuse` is
  significantly **worse** on top-1 (69/0, p < 0.001, net -69 = -28.8pp, 95% CI [-34.3, -22.8]pp, not equivalent),
  and the direction holds in every set (same -48.3pp p<.001, cross -16.7pp p=.002, third -25.0pp p<.001, mixed
  -25.0pp p<.001) — the opposite of what the plan's adoption rule requires (fuse would need to beat content with
  p < 0.05 on `all` and no set significantly worse). found@8 is inconclusive rather than a point in fuse's favor:
  5/0 pairs give p = 0.063 (not < 0.05) next to a 95% CI of [-4.0, -0.1]pp — outside ±3pp on the low end, so
  neither a finding nor equivalence. This is the exact small-count case the plan's own worked example describes
  (a handful of one-sided pairs reading as "neither"). Combined with fuse also losing to formula on top-1 (first
  bullet), fuse stays what Lyntai calls it — insurance, not the default.
- **Latency.** Serial medians (one arm at a time, 12 queries) run **8733-11722 ms** for every judge arm against
  **211-226 ms** for 公式 with no verification — roughly 40-55× slower per recall, regardless of whether the judge
  saw the topic only, the content only, or both (a CLI spawn per call dominates, not the size of what it reads).
  The parallel means (14249-15880 ms) are **not** a per-call estimate — they were measured with all 7 arms
  recalling at once, so they are contended; the serial pass is the closer estimate of a single household's
  per-recall cost.
- **CLI failures.** 6 claude-cli calls failed during the accuracy pass across the 5 judge arms combined (topic 1,
  content 3, contentonly 1, fuse 1, content2 0) against 234 graph recalls per arm (1170 judge calls total) — about
  0.5%. Every judge arm still produced a verdict for at least 98% of its graph recalls (topic 233/234 = 99.6%,
  content 231/234 = 98.7%, content2 234/234 = 100%, contentonly 233/234 = 99.6%, fuse 233/234 = 99.6%), so none
  crossed the bench's own 2%-unjudged threshold and **no arm failed open** on this run — the WARNING lines above
  name only the raw call failures, and no "judge failed open" line ever fired. The router counts every attempt, so
  a retried attempt that eventually succeeded would still show up as one of those failure lines; that caveat
  doesn't hide anything here, because judged equals graph minus failed exactly for all five arms (e.g. content:
  234 − 3 = 231), meaning each failed attempt cost its recall a verdict rather than being papered over by a
  successful retry.

### What it does NOT say

- One fixture (60 invented facts), one run per arm, a single judge model (`haiku`) and a single CLI version
  (`2.1.280 (Claude Code)`). Nothing here says how another model, another CLI version, or a household's own
  facts would score.
- 语义 was off in every arm — this measures the judge alone. Cross-language recall had no semantic channel to
  bridge languages, which is part of why even the best judge arm's cross/third-language top-1 stayed low (11/60
  and 16/60) next to same-language's 57/60; these numbers say what the judge alone buys, not judge + semantic.
- Kind-filtered recalls, which can carry up to 400 candidates, were not exercised — the fixture's 60 facts keep
  every recall inside the un-filtered graph regime, so nothing here says how the judge or the content-size
  tradeoff behaves at that scale.
- Candidate-text sizes are estimates that exclude prompt overhead (instructions, numbering, the query itself) and
  count characters, not tokens — they price the candidates only, not the full judge call.
- The fixture's questions are hand-reviewed, not raw generator output: 76 of 240 were edited in one commit, and
  the four Japanese facts' third-language questions were hand-written in another (per `judge-bench-fixture.mjs`'s
  own header). The questions this run answered were curated, not sampled unreviewed from a model.
- The `content` vs `content2` A/A pair — identical configuration, identical starting graph — still differed by
  2 queries (both in `cross`, p = 0.500, within the sanity threshold). That is the smallest real difference this
  run's own noise floor produced by chance alone; a reported gap of that size or smaller in any other comparison
  should be read as within the run's own measurement noise, not as a finding.
