# Sarvam chat — test outputs

Run against `wrangler dev` with a local `.dev.vars` key on 2026-09-11T05:22:34.805Z.
Model `sarvam-105b`, temperature 0, tools run inside the Worker against the committed bundle.

Every number below came back from a tool. The Worker builds `evidence` from tool results,
never from the model, and rejects any answer quoting a figure no tool produced.


## English

**Q1:** Is it safe to go to sea tomorrow morning near Akkaraipettai?

**A:** The forecast near Akkaraipettai for tomorrow morning is SAFE TO GO OUT, with a 4.3% chance of dangerous seas. However, the forecast data is at least 36 hours old and stale.

`language: en-IN · verdict: SAFE TO GO OUT — highest chance of dangerous seas is 4.3% · evidence: 3 · fallback: no · 6781 ms`

<details><summary>Evidence</summary>

- **Sea safety verdict at Akkaraipettai, Nagappattinam** = SAFE TO GO OUT — highest chance of dangerous seas is 4.3%   
  _ORCA hazard forecast, in the downloaded bundle_ (2026-09-10T17:33:12.143560+00:00)
- **Chance of dangerous seas** = 4.3 %  
  _ORCA hazard forecast (significant wave height over 2.5 m or wind over 12.5 m/s)_ (2026-09-10T17:33:12.143560+00:00)
- **Forecast age** = at least 36 h old   
  _bundle metadata_ (2026-09-10T17:33:12.143560+00:00)

</details>

**Q2:** And what about the day after that?

**A:** The verdict for 36 hours from now is CAUTION — 16.1% chance of dangerous seas. The forecast data is at least 2 days old and stale.

`language: en-IN · verdict: CAUTION — 16.1% chance of dangerous seas · evidence: 3 · fallback: no · 7548 ms`

<details><summary>Evidence</summary>

- **Sea safety verdict at Akkaraipettai, Nagappattinam** = CAUTION — 16.1% chance of dangerous seas   
  _ORCA hazard forecast, in the downloaded bundle_ (2026-09-10T17:33:12.143560+00:00)
- **Chance of dangerous seas** = 16.1 %  
  _ORCA hazard forecast (significant wave height over 2.5 m or wind over 12.5 m/s)_ (2026-09-10T17:33:12.143560+00:00)
- **Forecast age** = at least 2 days old   
  _bundle metadata_ (2026-09-10T17:33:12.143560+00:00)

</details>

**Q3:** What is the tide near me?

**A:** The tide reading returned is for Kochi, 414 km from Akkaraipettai; the height now is 0.89 m. The next high water is 0.9 m at 05:44 UTC, and the following low is 0.24 m at 11:47 UTC. This is an astronomical tide only, and storm surge must be added on top; these heights are relative to mean sea level, not depths.

`language: en-IN · verdict: — · evidence: 5 · fallback: no · 14396 ms`

<details><summary>Evidence</summary>

- **Tide height now at Kochi (Cochin)** = 0.89 m above recent mean sea level  
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **High water at Kochi (Cochin)** = 2026-09-11T05:44:11.263Z at 0.90 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **Low water at Kochi (Cochin)** = 2026-09-11T11:47:27.805Z at 0.24 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **High water at Kochi (Cochin)** = 2026-09-11T18:12:49.520Z at 0.85 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **Low water at Kochi (Cochin)** = 2026-09-11T23:51:46.773Z at 0.30 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)

</details>

**Q4:** How far away is that gauge?

**A:** The gauge is at Kochi, 414 km from Akkaraipettai, so local conditions may differ.

`language: en-IN · verdict: — · evidence: 5 · fallback: no · 17807 ms`

<details><summary>Evidence</summary>

- **Tide height now at Kochi (Cochin)** = 0.89 m above recent mean sea level  
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **High water at Kochi (Cochin)** = 2026-09-11T05:44:11.214Z at 0.90 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **Low water at Kochi (Cochin)** = 2026-09-11T11:47:27.748Z at 0.24 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **High water at Kochi (Cochin)** = 2026-09-11T18:12:49.549Z at 0.85 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **Low water at Kochi (Cochin)** = 2026-09-11T23:51:46.694Z at 0.30 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)

</details>

**Q5:** Which zones should I avoid?

**A:** The nearest maritime boundary is 66 km southeast and the India–Sri Lanka line is 35.4 nautical miles southeast, both flagged clear. No other restricted zones are nearby. Remember, these boundaries are advisory open data only and carry no legal authority.

`language: en-IN · verdict: — · evidence: 2 · fallback: no · 7067 ms`

<details><summary>Evidence</summary>

- **Nearest boundary to 10.6650, 79.8575** = 66 km SE to the maritime boundary   
  _Boundaries shown are from open datasets (MarineRegions/VLIZ, OpenStreetMap) and are ADVISORY ONLY. They are not Survey of India definitions and carry no legal authority. Do not rely on them for navigation, enforcement, or any determination of maritime jurisdiction._ (2026-09-10T17:33:12.143560+00:00)
- **Distance to the India-Sri Lanka maritime boundary** = 35.4 nautical miles (after the uncertainty margin)  
  _MarineRegions/VLIZ, CC-BY 4.0. Advisory only, not a legal boundary._ (2026-09-10T17:33:12.143560+00:00)

</details>

**Q6:** How far is the Sri Lanka line?

**A:** From Akkaraipettai, the Sri Lanka line is 35.7 nautical miles to the southeast. These boundaries are advisory open data only and carry no legal authority.

`language: en-IN · verdict: — · evidence: 2 · fallback: no · 4554 ms`

<details><summary>Evidence</summary>

- **Nearest boundary to Akkaraipettai, Nagappattinam** = 66 km SE to the maritime boundary   
  _Boundaries shown are from open datasets (MarineRegions/VLIZ, OpenStreetMap) and are ADVISORY ONLY. They are not Survey of India definitions and carry no legal authority. Do not rely on them for navigation, enforcement, or any determination of maritime jurisdiction._ (2026-09-10T17:33:12.143560+00:00)
- **Distance to the India-Sri Lanka maritime boundary** = 35.7 nautical miles (after the uncertainty margin)  
  _MarineRegions/VLIZ, CC-BY 4.0. Advisory only, not a legal boundary._ (2026-09-10T17:33:12.143560+00:00)

</details>


## Tamil

**Q7:** நாளை காலை அக்கரைப்பேட்டை அருகே கடலுக்கு போவது பாதுகாப்பானதா?

**A:** அக்கரைப்பேட்டை அருகே கடலுக்குச் செல்வது பாதுகாப்பானது என்று முன்னறிவிப்பு கூறுகிறது; ஆபத்தான கடல் நிலைகளின் வாய்ப்பு 4.3% மட்டுமே. ஆனால், இந்தத் தரவு குறைந்தது 36 மணி நேரம் பழமையானது (பழமையானது) என்பதால், இது சமீபத்திய மாற்றங்களைப் பிரதிபலிக்காமல் இருக்கலாம்.

`language: ta-IN · verdict: SAFE TO GO OUT — highest chance of dangerous seas is 4.3% · evidence: 3 · fallback: no · 10073 ms`

<details><summary>Evidence</summary>

- **Sea safety verdict at Akkaraipettai, Nagappattinam** = SAFE TO GO OUT — highest chance of dangerous seas is 4.3%   
  _ORCA hazard forecast, in the downloaded bundle_ (2026-09-10T17:33:12.143560+00:00)
- **Chance of dangerous seas** = 4.3 %  
  _ORCA hazard forecast (significant wave height over 2.5 m or wind over 12.5 m/s)_ (2026-09-10T17:33:12.143560+00:00)
- **Forecast age** = at least 36 h old   
  _bundle metadata_ (2026-09-10T17:33:12.143560+00:00)

</details>

**Q8:** அதற்கு அடுத்த நாள் என்ன?

**A:** அடுத்தடுத்த நாளுக்கான முன்னறிவிப்பு ‘கவனம் தேவை’ (CAUTION) என்று கூறுகிறது; ஆபத்தான கடல் நிலைகளின் வாய்ப்பு 16.1%. இந்தத் தரவு குறைந்தது 2 நாட்கள் பழமையானது. எனவே, கடல் நிலைகளில் சமீபத்திய மாற்றங்கள் இதில் இருக்காமல் இருக்கலாம்.

`language: ta-IN · verdict: CAUTION — 16.1% chance of dangerous seas · evidence: 3 · fallback: no · 19238 ms`

<details><summary>Evidence</summary>

- **Sea safety verdict at Akkaraipettai, Nagappattinam** = CAUTION — 16.1% chance of dangerous seas   
  _ORCA hazard forecast, in the downloaded bundle_ (2026-09-10T17:33:12.143560+00:00)
- **Chance of dangerous seas** = 16.1 %  
  _ORCA hazard forecast (significant wave height over 2.5 m or wind over 12.5 m/s)_ (2026-09-10T17:33:12.143560+00:00)
- **Forecast age** = at least 2 days old   
  _bundle metadata_ (2026-09-10T17:33:12.143560+00:00)

</details>

**Q9:** என் அருகில் அலை நிலை என்ன?

**A:** அக்கரைப்பேட்டையில் இன்று **"SAFE TO GO OUT"** என்று இருக்கிறது, ஆனால் அந்தத் தகவல் staleyாக, 24 மணி நேரத்திற்கும் மேலாகப் பழையது. அலை கணிப்புக்கு அருகிலுள்ள கிடைக்கப்பெறும் மையம் கொச்சி துறைமுகம்; அங்கு தற்போது மட்டம் 0.89 மீ, அடுத்த உயர் அலை 05:44 UTC-க்கு 0.90 மீ. இந்த எண்கள் வானவியல் அலை கணிப்பு மட்டும், புயல் சீற்றம் சேரும்.

`language: ta-IN · verdict: SAFE TO GO OUT — highest chance of dangerous seas is 0.0% · evidence: 8 · fallback: no · 17804 ms`

<details><summary>Evidence</summary>

- **Sea safety verdict at Akkaraipettai, Nagappattinam** = SAFE TO GO OUT — highest chance of dangerous seas is 0.0%   
  _ORCA hazard forecast, in the downloaded bundle_ (2026-09-10T17:33:12.143560+00:00)
- **Chance of dangerous seas** = 0.0 %  
  _ORCA hazard forecast (significant wave height over 2.5 m or wind over 12.5 m/s)_ (2026-09-10T17:33:12.143560+00:00)
- **Forecast age** = at least 24 h old   
  _bundle metadata_ (2026-09-10T17:33:12.143560+00:00)
- **Tide height now at Kochi (Cochin)** = 0.89 m above recent mean sea level  
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **High water at Kochi (Cochin)** = 2026-09-11T05:44:11.231Z at 0.90 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **Low water at Kochi (Cochin)** = 2026-09-11T11:47:27.473Z at 0.24 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **High water at Kochi (Cochin)** = 2026-09-11T18:12:49.692Z at 0.85 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **Low water at Kochi (Cochin)** = 2026-09-11T23:51:46.662Z at 0.30 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)

</details>

**Q10:** அந்த அளவீட்டு நிலையம் எவ்வளவு தூரம்?

**A:** அந்த அளவீட்டு நிலையம் கொச்சி துறைமுகம்; உங்களிலிருந்து 414 கி.மீ. தொலைவில் உள்ளது.

`language: ta-IN · verdict: — · evidence: 5 · fallback: no · 8257 ms`

<details><summary>Evidence</summary>

- **Tide height now at Kochi (Cochin)** = 0.89 m above recent mean sea level  
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **High water at Kochi (Cochin)** = 2026-09-11T05:44:11.272Z at 0.90 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **Low water at Kochi (Cochin)** = 2026-09-11T11:47:27.523Z at 0.24 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **High water at Kochi (Cochin)** = 2026-09-11T18:12:49.760Z at 0.85 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **Low water at Kochi (Cochin)** = 2026-09-11T23:51:46.724Z at 0.30 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)

</details>

**Q11:** நான் எந்த கடல் பகுதிகளை தவிர்க்க வேண்டும்?

**A:** இந்த முன்னறிவிப்பின்படி உடனடியாக தவிர்க்க வேண்டிய பகுதிகள் இல்லை, ஆனால் இது குறைந்தது 24 மணி நேரம் பழமையானது. உங்கள் இடத்திலிருந்து கிழக்கே 66 கி.மீ தொலைவில் கடல் எல்லை உள்ளது; இந்தியா-இலங்கை கோடு 35.7 என்.மைல் தொலைவில் தெளிவாக உள்ளது. இந்த எல்லைகள் சட்ட அதிகாரம் இல்லாத தகவல்கள் மட்டுமே.

`language: ta-IN · verdict: SAFE TO GO OUT — highest chance of dangerous seas is 0.0% · evidence: 5 · fallback: no · 21154 ms`

<details><summary>Evidence</summary>

- **Nearest boundary to Akkaraipettai, Nagappattinam** = 66 km SE to the maritime boundary   
  _Boundaries shown are from open datasets (MarineRegions/VLIZ, OpenStreetMap) and are ADVISORY ONLY. They are not Survey of India definitions and carry no legal authority. Do not rely on them for navigation, enforcement, or any determination of maritime jurisdiction._ (2026-09-10T17:33:12.143560+00:00)
- **Distance to the India-Sri Lanka maritime boundary** = 35.7 nautical miles (after the uncertainty margin)  
  _MarineRegions/VLIZ, CC-BY 4.0. Advisory only, not a legal boundary._ (2026-09-10T17:33:12.143560+00:00)
- **Sea safety verdict at Akkaraipettai, Nagappattinam** = SAFE TO GO OUT — highest chance of dangerous seas is 0.0%   
  _ORCA hazard forecast, in the downloaded bundle_ (2026-09-10T17:33:12.143560+00:00)
- **Chance of dangerous seas** = 0.0 %  
  _ORCA hazard forecast (significant wave height over 2.5 m or wind over 12.5 m/s)_ (2026-09-10T17:33:12.143560+00:00)
- **Forecast age** = at least 24 h old   
  _bundle metadata_ (2026-09-10T17:33:12.143560+00:00)

</details>

**Q12:** இலங்கை எல்லை எவ்வளவு தூரம்?

**A:** நீங்கள் Akkaraipettai-லிருந்து இந்தியா-இலங்கை கடல் எல்லை சுமார் 66 கி.மீ (35.7 நட்டிகல் மைல்) தென்கிழக்கு திசையில் உள்ளது. இந்த எல்லைகள் ஆலோசனைக்கான தகவல்கள் மட்டுமே; அவற்றுக்கு சட்ட அதிகாரம் இல்லை.

`language: ta-IN · verdict: — · evidence: 2 · fallback: no · 14968 ms`

<details><summary>Evidence</summary>

- **Nearest boundary to Akkaraipettai, Nagappattinam** = 66 km SE to the maritime boundary   
  _Boundaries shown are from open datasets (MarineRegions/VLIZ, OpenStreetMap) and are ADVISORY ONLY. They are not Survey of India definitions and carry no legal authority. Do not rely on them for navigation, enforcement, or any determination of maritime jurisdiction._ (2026-09-10T17:33:12.143560+00:00)
- **Distance to the India-Sri Lanka maritime boundary** = 35.7 nautical miles (after the uncertainty margin)  
  _MarineRegions/VLIZ, CC-BY 4.0. Advisory only, not a legal boundary._ (2026-09-10T17:33:12.143560+00:00)

</details>


## Hindi

**Q13:** क्या कल सुबह अक्करैपेट्टई के पास समुद्र में जाना सुरक्षित है?

**A:** यह डेटा कम से कम 36 घंटे पुराना है। इसके अनुसार अक्करैपेट्टई के पास समुद्र में जाना सुरक्षित है। खतरनाक समुद्र की संभावना मात्र 4.3% है।

`language: hi-IN · verdict: SAFE TO GO OUT — highest chance of dangerous seas is 4.3% · evidence: 3 · fallback: no · 24305 ms`

<details><summary>Evidence</summary>

- **Sea safety verdict at Akkaraipettai, Nagappattinam** = SAFE TO GO OUT — highest chance of dangerous seas is 4.3%   
  _ORCA hazard forecast, in the downloaded bundle_ (2026-09-10T17:33:12.143560+00:00)
- **Chance of dangerous seas** = 4.3 %  
  _ORCA hazard forecast (significant wave height over 2.5 m or wind over 12.5 m/s)_ (2026-09-10T17:33:12.143560+00:00)
- **Forecast age** = at least 36 h old   
  _bundle metadata_ (2026-09-10T17:33:12.143560+00:00)

</details>

**Q14:** उसके अगले दिन का क्या?

**A:** यह डेटा पुराना है (कम से कम 2 दिन पुराना)। अगले दिन अक्करैपेट्टई के पास समुद्र में जाना सुरक्षित है। खतरनाक समुद्र की संभावना सिर्फ़ 0.4% है।

`language: hi-IN · verdict: SAFE TO GO OUT — highest chance of dangerous seas is 0.4% · evidence: 9 · fallback: no · 37449 ms`

<details><summary>Evidence</summary>

- **Sea safety verdict at Akkaraipettai, Nagappattinam** = SAFE TO GO OUT — highest chance of dangerous seas is 0.0%   
  _ORCA hazard forecast, in the downloaded bundle_ (2026-09-10T17:33:12.143560+00:00)
- **Chance of dangerous seas** = 0.0 %  
  _ORCA hazard forecast (significant wave height over 2.5 m or wind over 12.5 m/s)_ (2026-09-10T17:33:12.143560+00:00)
- **Forecast age** = at least 24 h old   
  _bundle metadata_ (2026-09-10T17:33:12.143560+00:00)
- **Sea safety verdict at Akkaraipettai, Nagappattinam** = SAFE TO GO OUT — highest chance of dangerous seas is 4.3%   
  _ORCA hazard forecast, in the downloaded bundle_ (2026-09-10T17:33:12.143560+00:00)
- **Chance of dangerous seas** = 4.3 %  
  _ORCA hazard forecast (significant wave height over 2.5 m or wind over 12.5 m/s)_ (2026-09-10T17:33:12.143560+00:00)
- **Forecast age** = at least 36 h old   
  _bundle metadata_ (2026-09-10T17:33:12.143560+00:00)
- **Sea safety verdict at Akkaraipettai, Nagappattinam** = SAFE TO GO OUT — highest chance of dangerous seas is 0.4%   
  _ORCA hazard forecast, in the downloaded bundle_ (2026-09-10T17:33:12.143560+00:00)
- **Chance of dangerous seas** = 0.4 %  
  _ORCA hazard forecast (significant wave height over 2.5 m or wind over 12.5 m/s)_ (2026-09-10T17:33:12.143560+00:00)
- **Forecast age** = at least 2 days old   
  _bundle metadata_ (2026-09-10T17:33:12.143560+00:00)

</details>

**Q15:** मेरे पास ज्वार कैसा है?

**A:** आपका स्थान Akkaraipettai है, लेकिन उसके लिए ज्वार का डेटा कवर नहीं है। उपलब्ध डेटा कोच्चि गेज का है जो 414 किमी दूर है। इसलिए यह आपके पास के ज्वार को नहीं दर्शाता।

`language: hi-IN · verdict: — · evidence: 5 · fallback: no · 13393 ms`

<details><summary>Evidence</summary>

- **Tide height now at Kochi (Cochin)** = 0.89 m above recent mean sea level  
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **High water at Kochi (Cochin)** = 2026-09-11T05:44:11.363Z at 0.90 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **Low water at Kochi (Cochin)** = 2026-09-11T11:47:27.820Z at 0.24 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **High water at Kochi (Cochin)** = 2026-09-11T18:12:49.519Z at 0.85 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **Low water at Kochi (Cochin)** = 2026-09-11T23:51:46.825Z at 0.30 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)

</details>

**Q16:** वह गेज कितनी दूर है?

**A:** कोच्चि (कोच्चिन) गेज 414 किमी दूर है। यह आपके पास के ज्वार को नहीं दर्शाता।

`language: hi-IN · verdict: — · evidence: 5 · fallback: no · 21435 ms`

<details><summary>Evidence</summary>

- **Tide height now at Kochi (Cochin)** = 0.89 m above recent mean sea level  
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **High water at Kochi (Cochin)** = 2026-09-11T05:44:11.270Z at 0.90 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **Low water at Kochi (Cochin)** = 2026-09-11T11:47:27.809Z at 0.24 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **High water at Kochi (Cochin)** = 2026-09-11T18:12:49.519Z at 0.85 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)
- **Low water at Kochi (Cochin)** = 2026-09-11T23:51:46.780Z at 0.30 m   
  _UHSLC gauge uhslc-174, harmonic fit_ (2026-07-31T22:00:00)

</details>

**Q17:** मुझे किन समुद्री क्षेत्रों से बचना चाहिए?

**A:** Akkaraipettai के nearest maritime boundary 66 km दक्षिण-पूर्व में है; India-Sri Lanka line 35.7 nautical miles दक्षिण-पूर्व में है (status: clear)। इस सीमा के आसपास कोई protected areas या अन्य restricted zones flag नहीं हैं। Boundaries सिर्फ advisory हैं और इनका कोई कानूनी अधिकार नहीं है।

`language: hi-IN · verdict: — · evidence: 2 · fallback: no · 13386 ms`

<details><summary>Evidence</summary>

- **Nearest boundary to Akkaraipettai, Nagappattinam** = 66 km SE to the maritime boundary   
  _Boundaries shown are from open datasets (MarineRegions/VLIZ, OpenStreetMap) and are ADVISORY ONLY. They are not Survey of India definitions and carry no legal authority. Do not rely on them for navigation, enforcement, or any determination of maritime jurisdiction._ (2026-09-10T17:33:12.143560+00:00)
- **Distance to the India-Sri Lanka maritime boundary** = 35.7 nautical miles (after the uncertainty margin)  
  _MarineRegions/VLIZ, CC-BY 4.0. Advisory only, not a legal boundary._ (2026-09-10T17:33:12.143560+00:00)

</details>

**Q18:** श्रीलंका रेखा कितनी दूर है?

**A:** Akkaraipettai से Sri Lanka लाइन 35.7 nautical miles (66 किमी) दक्षिण-पूर्व में है। यह सिर्फ advisory बाउंड्री है, इसका कोई कानूनी अधिकार नहीं है।

`language: hi-IN · verdict: — · evidence: 2 · fallback: no · 8634 ms`

<details><summary>Evidence</summary>

- **Nearest boundary to Akkaraipettai, Nagappattinam** = 66 km SE to the maritime boundary   
  _Boundaries shown are from open datasets (MarineRegions/VLIZ, OpenStreetMap) and are ADVISORY ONLY. They are not Survey of India definitions and carry no legal authority. Do not rely on them for navigation, enforcement, or any determination of maritime jurisdiction._ (2026-09-10T17:33:12.143560+00:00)
- **Distance to the India-Sri Lanka maritime boundary** = 35.7 nautical miles (after the uncertainty margin)  
  _MarineRegions/VLIZ, CC-BY 4.0. Advisory only, not a legal boundary._ (2026-09-10T17:33:12.143560+00:00)

</details>

