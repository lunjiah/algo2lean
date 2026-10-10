# Change log

## 0.1.1 — 2026-10-10

- Add a visible notice that proof checking is not currently available on the website. Users can save the supplied proofs and check them with their own Lean installation or editor.
- Clarify the hosted getting-started instructions. Local proof checking remains available.

Validation: 42 focused website/release tests, all 169 JavaScript tests, and a live browser preview pass. Compiler semantics and Lean proofs are unchanged.

## 0.1.0 — 2026-10-09

- Compile typed Python-like algorithms to Lean definitions with shared mutable sequences, classes, imports, named locations, and weighted clocks.
- Reuse correctness and runtime analyses through module interfaces and contracts.
- Explore checked examples from loops and merge sort to Dijkstra, Fibonacci heaps, and matrix multiplication.
- Use the local editor or the hosted browser compiler at https://lunjiah.github.io/algo2lean/, with exact generation comparison, downloadable manifests, and preserved version archives.
- Include source, tests, proof modules, current guides, citation metadata, and third-party runtime notices.

The compiler is tested but not itself formally verified. Browser generation verification does not check Lean proofs; use the local checker with the pinned Lean toolchain.
