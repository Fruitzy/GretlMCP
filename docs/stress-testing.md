# Stress Testing

Run the broad MCP stress suite after building:

```powershell
npm run build
npm run stress
```

The suite starts the built stdio MCP server and calls real MCP tools. It covers:

- Gretl capability discovery.
- Nonlinear least squares with bad starts, OLS-derived starts, analytical
  derivatives, and numerical derivatives.
- Mixed-frequency imports from the bundled `fedstl.bin` database using average,
  first, last, sum, and spread compaction.
- Panel estimation using pooled OLS, fixed effects, random effects, first
  differences, a dynamic lagged-dependent-variable specification, and manual
  unit dummies.
- ARCH/GARCH estimation and graph artifact generation from `$h`.
- IV/2SLS simulation with valid, weak, and invalid instruments.
- A reproducible project that writes `main.inp`, `data/`, `output/`, saved
  graphs, model output, and a report text file.

The foreign-language integration case is dependency-gated. It is reported as
skipped unless a working `python`, `Rscript`, or `octave` executable is available
on `PATH`; Gretl itself supports this through `foreign language=...`, but the
external runtime has to exist on the user's machine.
