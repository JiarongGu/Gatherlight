### 本地模型 search: measured, and the recommendation changed

The models offered for **本地模型** were picked from general knowledge and never tested on the job this app
actually gives them — finding a note whose *meaning* answers a question worded nothing like it. They have
now been measured, on a mixed Chinese/English set of notes with questions deliberately worded to share no
words with their answers:

| model | found it in the top 3 | per search | size |
|---|---|---|---|
| **EmbeddingGemma 300M** | **10 / 10** | 0.27 s | 622 MB |
| BGE-M3 | 10 / 10 | 0.34 s | 1.2 GB |
| Qwen3 Embedding 0.6B | 10 / 10 | 1.57 s | 640 MB |
| Nomic Embed Text | **4 / 10** | 0.07 s | 274 MB |

Two things changed as a result. **EmbeddingGemma is now the recommendation** — it was not on the list at
all before. And **Nomic Embed Text is marked as unsuitable for Chinese**: it was previously suggested for
any computer without a graphics card, and it misses more than half of these searches, every miss being a
Chinese question. If you turned the local model on before this release and kept the suggested model, you
were almost certainly using that one — switching is worth it.

The panel now shows those numbers side by side instead of describing each model in a paragraph, so you can
compare quality, size and speed in one look, and it says what the measurement was and where it is too small
to settle a close call.

**The list is no longer a limit.** You can type any Ollama model name and use it — a model released after
this version no longer has to wait for the next one. Before saving, the app makes the model compute one
vector: if it cannot, the setting is refused rather than leaving your search quietly finding nothing.

### The assistant can judge its own memory on your computer

The part of memory search that labels each note as it is saved, and decides which results actually answered
your question, ran only through Claude. You can now point it at a model on your own computer instead
(**校准 · Cortex** → **Claude CLI 增强** → 本机模型).

It is not a downgrade: on the library's own measurements a local `gemma3:4b` finds more of what matters and
admits less junk than the reference it was tested against. What you gain is that it stops using your Claude
account for the most frequent call the app makes — memory is touched on every note saved and every search —
it stops needing the network, and it keeps working offline. Changing where it runs needs a restart; turning
it on and off does not.

Chat, planning and everything else still run on Claude. This setting moves only the memory judgement.

### 重建索引 shows what it is doing

Rebuilding the search index re-reads every note, and with the Claude enhancement on it makes a model call
for each — minutes on a large collection. Until now the button simply greyed out, with no count and no bar,
which was impossible to tell apart from the app having hung; and on a long rebuild the browser could give up
while the work carried on, reporting a failure for something that actually finished.

It now returns immediately and shows progress — how many notes of how many — and reports the result when it
ends. Only one rebuild runs at a time.

The panel also tells you when the index does not cover everything you know, which can happen if a rebuild is
interrupted by a restart. Nothing is lost when that happens: the uncovered notes are still found by keyword,
and the next start quietly finishes the job.
