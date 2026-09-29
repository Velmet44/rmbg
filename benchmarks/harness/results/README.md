# Results (not in git)

Populated by `npm run measure --workspace @rmbg/harness`:

```
results/<model>_<repo>/<device>/summary.json
results/<model>_<repo>/<device>/<fixture>.mask.png   # human rating
```

`summary.json` records download bytes, cold init, cold/warm inference ms,
and mask dimensions per fixture. Quality rating is human (view the mask PNGs)
until ground-truth masks land in `fixtures/` for automatic IoU scoring.
