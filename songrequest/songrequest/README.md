# Song requests

Your audience scans a QR code, picks a song from your list, and it lands in a live queue on your tablet. Your tablet shows the lyrics and chords and scrolls them for you while you play.

- **Audience page:** your site's main address, for example `https://your-app.onrender.com/`
- **Stage view (your tablet):** the same address with `/stage` on the end. It asks for your PIN.

## Put it online (free, about 10 minutes)

The audience's phones need to reach it over the internet, so it has to be hosted. Any host that runs Node.js works. These steps use Render.

1. Make a free account at github.com and create a new repository. Upload everything in this folder to it (the "uploading an existing file" link on the new repository page lets you drag the files in).
2. Make a free account at render.com. Choose **New**, then **Web Service**, and pick your repository.
3. Use these settings:
   - Runtime: **Node**
   - Build command: leave empty (or `echo ok`)
   - Start command: `node server.js`
   - Instance type: **Free**
4. Under **Environment**, add a variable named `STAGE_PIN` and set it to a PIN only you know, for example `7391`.
5. Deploy. When it finishes, Render shows your web address.

Open `your-address/stage` on the tablet, enter the PIN, and open the **Share** tab. The QR code there points at your audience page. Print it, or leave it on the tablet screen when nothing is playing (the stage view shows it big while no song is selected).

## Before each gig

- Free hosts usually put the app to sleep when nobody has used it for a while, and the first visit can take up to a minute to wake it. Open the stage view on the tablet 10 minutes before you start.
- In your browser's menu choose **Add to Home Screen** for a full-screen stage view. The screen stays awake while it is open.
- Your songs are saved on the tablet as well as the server. If the server restarts and forgets them, they are put back when you open the stage view. Use **Share, Export songs** now and then to keep a copy as a file.

## Adding songs

Open the **Songs** tab, then **Add a song**, and paste your lyrics. Two formats work and you can mix them:

```
[Verse 1]
[G]Amazing grace, how [C]sweet the [G]sound
```

Chords in square brackets go right before the word they land on.

```
Chorus
Am        G         Am
Are you going to Scarborough Fair?
```

Chords on their own line above the lyrics, as copied from most chord sites. Lines such as `[Chorus]`, `Verse 2` or `Bridge` become section labels.

The two example songs are there so you can see how it looks. Delete them whenever you like.

## On stage

- Tap the lyrics once to start or stop scrolling. Drag them to move by hand.
- **Speed** is remembered for each song.
- **A-** and **A+** change the text size.
- **Next** plays the song at the top of the request queue, or the next song on your setlist when there are no requests. **Play** on any request jumps to it.
- **Set tab:** build tonight's setlist with **+ Set** in the Songs tab, then reorder with Up and Down. Requests play before the setlist. A song comes off the setlist once it is played, so a requested song is never played twice.
- **Tempo scrolling:** give a song a BPM, beats per bar and bars per line when you edit it. The lyrics then scroll in time, and the speed buttons become BPM buttons for fine-tuning.
- **Requests open** in the top bar closes or reopens requests.
- If several people ask for the same song it appears once, with a count.

## Trying it on your own computer

You need Node.js 18 or newer.

```
STAGE_PIN=1234 node server.js
```

Then open `http://localhost:3000/stage`. Phones can only reach it from your computer if they are on the same network, and the QR code will point at your computer's address, so use a hosted copy for real gigs.

## Notes

- Requests are limited so one phone cannot flood the queue: one request every few seconds, and one request per song per phone while it is in the queue.
- Anyone with the stage PIN controls the show. Pick one that is not obvious.
- The QR code is drawn with the MIT-licensed `qrcode-generator` library by Kazuhiko Arase (`public/qrcode.js`).
