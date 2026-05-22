# SabiWabi — marketplace shop profiles

Complete shop icons and bios for every marketplace the factory lists on.
Brand: **SabiWabi** — a studio selling original, AI-designed, 3D-printable
character figurines (instant STL + GLB digital downloads).

## What's in here

```
branding/
  icons/
    master.png                  2048×2048  raw generation (keep as source)
    icon-master-1024.png         1024×1024  high-res master crop
    icon-square-1480.png         1480×1480  centered crop, lossless source
    icon-etsy-500.png             500×500   Etsy shop icon
    icon-sketchfab-512.png        512×512   Sketchfab avatar
    icon-gumroad-512.png          512×512   Gumroad profile picture
    icon-cults3d-512.png          512×512   Cults3D profile picture
    icon-myminifactory-512.png    512×512   MyMiniFactory profile image
    _preview-circle.png           512×512   circle-crop preview (not for upload)
  banners/
    banner-etsy-3360x840.png        3360×840  Etsy big banner
    banner-sketchfab-2000x500.png   2000×500  Sketchfab profile cover
    banner-myminifactory-1920x480.png 1920×480 MyMiniFactory cover
    banner-cults3d-1600x400.png     1600×400  Cults3D profile background
  bios/
    etsy.md  cults3d.md  sketchfab.md  myminifactory.md  gumroad.md
  build_banners.py                 regenerates the banners (free, no API)
  README.md                        this file
```

The icon is one master mascot (warm clay 3D figurine, terracotta hood, sage
leaf, gentle smile) resized per platform. The banners reuse that mascot as a
circular badge with the SabiWabi wordmark — composed in-repo, no API. All bios
are in `bios/*.md` as paste-ready blocks with correct field labels and limits.
(Gumroad has no native profile banner, so there isn't one.)

## Important: profile branding is NOT API-pushable

Across all five marketplaces, **shop icon and bio/about text must be set in the
web UI.** None expose a public API for profile branding. Verified May 2026:

| Marketplace | Icon via API | Bio via API | Notes |
|-------------|--------------|-------------|-------|
| Etsy        | No           | Partial     | API `updateShop` can set **title + announcement** only (needs `shops_w` scope). Icon, banner, About section = UI only. |
| Cults3D     | No           | No          | GraphQL API is read-only for profiles. |
| Sketchfab   | No           | No          | `/v3/me` is read-only. |
| MyMiniFactory | No         | No          | No profile-write endpoint. |
| Gumroad     | No           | No          | API covers products only. |

So setting these profiles is a manual web-UI task. The per-platform files
below give you exact paste-ready copy so it takes a couple of minutes each.

## Current account identities (pulled live from each API)

The accounts were created with throwaway names. Recommend unifying the public
**display name** to `SabiWabi` everywhere (the URL slug/username usually can't
be changed and doesn't need to be).

| Marketplace   | Username / slug | Current display name | Recommended display name |
|---------------|-----------------|----------------------|--------------------------|
| Etsy          | SabiWabiGifts   | SabiWabiGifts        | (already on-brand)       |
| Cults3D       | samd5           | samd5                | SabiWabi                 |
| Sketchfab     | spx500          | **3D Goat**          | SabiWabi                 |
| MyMiniFactory | (account 74865) | **lam preston**      | SabiWabi                 |
| Gumroad       | 7057463510061   | **Sam Davila**       | SabiWabi                 |

## Apply checklist

### Etsy — `bios/etsy.md`
1. Shop Manager → Settings → Info & appearance → upload `icon-etsy-500.png`
   and the banner `banners/banner-etsy-3360x840.png`.
2. Same page → Shop title → paste the title block.
3. Shop Manager → click shop name → Edit shop → paste the Announcement.
4. About section → paste Story Headline + Story.

   *Shortcut:* once Etsy is reconnected (so the token carries the new
   `shops_w` scope), the **title + announcement** can be pushed from the app —
   `cmd_etsy_update_shop_profile { title, announcement }`. Icon + About still UI.

### Cults3D — `bios/cults3d.md`
Settings / Edit profile → upload `icon-cults3d-512.png` + the profile
background `banners/banner-cults3d-1600x400.png`, set display name to
`SabiWabi`, paste the description.

### Sketchfab — `bios/sketchfab.md`
Settings → Profile → upload `icon-sketchfab-512.png` + the cover image
`banners/banner-sketchfab-2000x500.png`, change display name from
"3D Goat" to `SabiWabi`, paste the biography.

### MyMiniFactory — `bios/myminifactory.md`
Settings → Profile → upload `icon-myminifactory-512.png` + the cover
`banners/banner-myminifactory-1920x480.png`, change name from
"lam preston" to `SabiWabi`, paste the About Me text.

### Gumroad — `bios/gumroad.md`
Settings → Profile → upload `icon-gumroad-512.png`, change name from
"Sam Davila" to `SabiWabi`, paste the bio.

## Not done here

- **Pinterest** — not connected and not a sales channel, so it's excluded.

## Regenerating the assets

- **Icon** — master generated via Higgsfield `nano_banana_2`. Per-platform
  sizes are a centered crop of the 2048×2048 master at box
  `(284, 300, 1764, 1780)`, then resized.
- **Banners** — run `python3 branding/build_banners.py` (free, no API). It
  reuses `icons/icon-square-1480.png` and the brand palette, so the banners
  always match the current icon. Re-run it after changing the icon.
