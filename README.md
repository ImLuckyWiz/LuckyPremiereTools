# LuckyTwitch Markers: Premiere Pro panel (CEP)

The official Premiere Pro panel for LuckyTwitch Downloader. It reads the `.markers.json` file written by LuckyTwitch Downloader and does the whole edit of a Twitch VOD for you, in one button:

1. **adds the markers** (games and clips, colored) to the video,
2. **cuts** the timeline around every clip (with the padding you choose),
3. **deletes the gaps** between the clips (ripple delete, so the clips end up back to back),
4. **links** each video piece to its audio piece again,

and then **reads the whole result back** from Premiere and only says "done" if everything matches the plan.

## Install

You can install the panel either with a 1-click ZXP installer or with the included install script:

### Option 1: 1-Click Install (.zxp)
Download **`LuckyTwitch-Premiere-Plugin-CEP.zxp`** and drag it into:
- [ZXPInstaller](https://zxpinstaller.com/)
- [Anastasiy's Extension Manager](https://install.anastasiy.com/)
- aescripts + aeplugins manager

### Option 2: Manual Install (.zip)
Download and unzip **`LuckyTwitch-Premiere-Plugin-CEP.zip`**. The installer copies the panel to the right place and switches on Adobe's "allow unsigned panels" flag (`PlayerDebugMode`, per user, harmless):

**Windows**
1. Double-click **`install.bat`**. The window lists every file it installed.
2. Restart Premiere Pro and open **Window > Extensions > LuckyTwitch Markers**.

**macOS**
1. Double-click **`install-mac.command`** (if macOS blocks it: right-click > Open, or run `bash install-mac.command` in Terminal).
2. Restart Premiere Pro and open **Window > Extensions > LuckyTwitch Markers**.

To remove it: `install.bat -Uninstall` (Windows) or `./install-mac.command --uninstall` (macOS). The installer also removes the panel's old test build (`com.luckytwitch.ceptest`) if you had it.

The manifest allows Premiere Pro 14.0 (2020) and newer; it was checked on Premiere Pro 26.5.

## Use

1. In LuckyTwitch Downloader tick **Also export a .markers.json for the LuckyTwitch Premiere plugin** (and **Also mark the game / category changes** if you want games), and download as usual.
2. In Premiere, make a **new sequence from the video** (video on V1, its audio on A1, nothing else) and **save the project (Ctrl+S)**.
3. Open the panel. It finds the `.markers.json` next to the video (or next to the project) by itself, reads the timeline, and shows **what will happen**: how many markers, cuts, deletes and links, and a rough time.
4. Press **Do it all**, confirm once, and leave Premiere alone until it says *Done*. The bar and the four rows show where it is.

If something is wrong the panel tells you before you press anything (the big button turns into *Check again*), and a run stops at the first failed check without retrying anything. If a run is stopped (Stop button, or a failed check), pressing the button again **continues where it stopped**: it works out what is left.

**Single steps** (collapsed under the button) run one part alone: only the markers, only the cuts, only the deletes, only the relink. **Detailed check (log)** prints every safety check without touching anything; **Remove the plan's markers** takes exactly the markers the plan adds off the clip again.

### Settings

| Setting | Meaning |
|---|---|
| Recipe | Preset configurations (*Default*, *Safety (5s)*, *Tight Cut & Delete*) or custom values |
| Scope to chapter | Restrict cuts, gap deletes, and markers strictly inside one selected game/chapter |
| Before / after each clip | seconds kept around every clip (the "safety cut"). 10 and 10 keeps 10 s before and after |
| Merge clips closer than | clips that touch after padding become one piece |
| Also cut at every game / category change | adds a cut at each game change |
| Also add the markers | the first step of Do it all. Markers can only be added **before the first cut** |
| Refuse to delete more than | the delete limit, in % of the timeline (default 99) |
| Need at least N pieces to keep | refuse if fewer would be left |

They are remembered across sessions. Starting padding values written into `.markers.json` by LuckyTwitch Downloader are automatically adopted until customized. Keep them the same from the first cut to the delete: if you change the padding after cutting, the delete refuses (the cuts no longer match the plan); change it back, or undo.

### What it checks first (the failsafe)

It refuses to start, and says why, if: anything is on V2+/A2+; V1 or A1 is not exactly one whole clip (or a run of its own pieces); the clip is trimmed, sped up, or does not start at the start of the sequence; the audio is not the video's audio; the sequence uses drop-frame timecode; the markers file is for another video; or the delete plan is unsafe (more than the limit, or too few pieces left). Before every step it reads the timeline again, and after every chunk of work it checks the result.

## Troubleshooting

- **The panel is not in Window > Extensions:** restart Premiere after installing. Check that `%APPDATA%\Adobe\CEP\extensions\com.luckytwitch.markers` (macOS: `~/Library/Application Support/Adobe/CEP/extensions/com.luckytwitch.markers`) exists and that the installer said `manifest.xml OK`.
- **A run stopped:** open **Log** at the bottom, press **Copy log**, and read the last `[STOP]` / `check: FAIL` line. Nothing is retried by itself.
- **Undo:** Ctrl+Z undoes edits one by one; the saved project is untouched until you save again, so reopening it also works.
- **Debugger (optional):** with the panel open, `http://localhost:8099` in Chrome.

## For developers

See [`DEVELOPMENT.md`](DEVELOPMENT.md) (layout, tests, how the panel was verified). Tests: `cd premiere-plugin-cep && npm test` (Node 20+, no dependencies).
