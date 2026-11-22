# addonSI

Unofficial addon modules for Sora-compatible streaming apps, self-indulgent project by [@fudgeebohr](https://github.com/fudgeebohr).

> [!WARNING]
> These addons depend on third-party websites and APIs. Availability and behavior may change without notice.

## Available addons

| Addon | Type | Stream format | Manifest |
| --- | --- | --- | --- |
| Aniwaves | Anime | HLS | [aniwave.json](Aniwave/aniwave.json) |
| Bilibili | General | MP4 / DASH | [bilibili.json](Bilibili/bilibili.json) |
| KissKH | Shows | HLS | [kisskh.json](KissKH/kisskh.json) |



## Notes

- The addons use public or website-facing endpoints and may stop working when providers change their pages or APIs.
- The Bilibili module may use a configured relay for synchronized video and audio playback. Its relay endpoint is not included as a repository worker.
- The Aniwaves modules contain player protocol constants that may need periodic updates when upstream services rotate keys or routes.
- This project is not affiliated with any website mentioned here.