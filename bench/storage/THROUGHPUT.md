## 1 GiB throughput and memory

Measured by `npm run bench:throughput` on 2026-10-23T00:17:38.491Z with Node
`v24.15.0` on Intel(R) Core(TM) i5-8257U CPU @ 1.40GHz. Scope: the shipped erasure path
(`encodeBytes`/`decodeBytes`, 4+2), not HTTP or JSON
framing. That is the compute cost inside a put and a get.

| Payload | Shards | Stored | Encode | Encode throughput | Decode | Decode throughput | Peak RSS | Exact |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1024 MiB | 6 | 1536.0 MiB | 90.77 s | 11.3 MiB/s | 21.27 s | 48.2 MiB/s | 3627.5 MiB | yes |

Peak RSS comes from `process.resourceUsage().maxRSS` and includes the 1 GiB
payload, all shards, and the decoder working set held in memory at once. It is an
upper bound for one in-memory blob, not a steady-state daemon footprint.
