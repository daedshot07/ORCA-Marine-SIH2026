/**
 * Every translatable string, as frozen literals.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE SHIPPING TO ANYONE WHO DEPENDS ON IT
 * ---------------------------------------------------------------------------
 * THE ml, ta AND hi TABLES HAVE NOT BEEN CHECKED BY A NATIVE SPEAKER.
 *
 * They were written by a language model. This project's first non-negotiable
 * constraint is "NO LLM anywhere. Not for planning, not for phrasing", and
 * these tables sit inside that rule, not outside it: "DO NOT GO OUT" rendered
 * wrongly in Malayalam is the exact failure the rule exists to prevent, and
 * nobody on this team can currently tell whether it has happened.
 *
 * The runtime is clean -- t() is a lookup in this frozen table and generates
 * nothing. The authorship is not. That is a real gap and it is recorded here
 * rather than left for someone to discover in front of a fisherman.
 *
 * WHAT TO DO. Sit a native speaker down with this file. Each entry has its
 * English directly above it, so the review is line by line and needs no
 * tooling. When a table has been checked end to end, set `reviewed: true` for
 * that language in src/i18n/index.ts and the in-app warning disappears.
 *
 * Until then the app shows an unmissable banner in any unreviewed language.
 * Do not remove that banner to make a demo look tidier.
 *
 * ---------------------------------------------------------------------------
 * SCOPE
 * ---------------------------------------------------------------------------
 * The escape screen, the verdict words, compass directions and place types --
 * everything someone reads while deciding whether to go out or where to run.
 * The provenance and data-age prose on the home screen is still English only;
 * it is read at leisure, by someone who chose to open a disclosure, and it was
 * not worth doubling the review burden for.
 *
 * NUMBERS NEVER PASS THROUGH HERE. Distances, percentages, bearings and times
 * are formatted by src/compute/format.ts and substituted into {placeholders},
 * so no entry in this file can change a number. It can only change the words
 * around one.
 */

export type LanguageCode = "en" | "ml" | "ta" | "hi";

const en = {
  // --- the escape screen ---------------------------------------------------
  escapeTitle: "SAFE PLACE",
  close: "Close",
  escapeOpenWord: "ESCAPE",
  escapeOpenSub: "nearest safe place · works offline",

  gpsSearching: "Finding your location… (GPS works without internet)",
  gpsOk: "Location: GPS, accurate to about {m} m. Works without internet.",
  gpsManual:
    "MANUAL POSITION, not a GPS fix. Directions are measured from the place " +
    "you picked, not from where you are.",
  gpsDenied:
    "Location is off for this app. Turn it on in your browser settings, or " +
    "pick your place by hand below.",
  gpsTimeout:
    "No GPS fix yet. Go outside with a clear view of the sky, or pick your " +
    "place by hand below.",
  gpsUnavailable: "This device cannot give a location. Pick your place by hand below.",

  go: "GO {direction}",
  straightLineWarning: "Straight-line direction. Follow roads and official instructions.",
  compassLive: "Arrow follows your phone. Hold it flat.",
  compassNone:
    "NORTH IS UP. No compass on this device, so the arrow is a map bearing, " +
    "not a point-the-phone arrow.",

  manualSummary: "No GPS? Pick your place by hand",
  manualUse: "Use this place",

  noPlaceList: "NO PLACE LIST ON THIS DEVICE",
  noPlaceListHelp: "Open this app once with a connection to download one.",
  noPlaceListShort: "No list of places on this device.",
  waitingForFix: "Waiting for a location before the nearest places can be worked out.",
  nothingClose:
    "Nothing close by. The nearest is {km} away, which is {time} on foot. Shown anyway.",

  onFoot: "at least {time} on foot",
  aboveSeaShort: "{m} m above sea",
  aboveSeaLong: "ground {m} m above sea level",
  walkSuffix: "{time}+ walk",

  mapNeedsFix: "The map appears once there is a location.",
  mapNeedsFixHelp: "Allow location, or pick a place by hand below.",
  mapNoPlaces: "No places on this device to map.",
  mapNoPlacesHelp: "Open the app once with a connection.",

  notRegister:
    "These are community-mapped buildings, not an official shelter register. " +
    "Nobody has checked that they are open, staffed, above the water or still " +
    "standing.",

  // --- the verdict words ---------------------------------------------------
  verdictSafe: "SAFE TO GO OUT",
  verdictCaution: "CAUTION",
  verdictDanger: "DO NOT GO OUT",
  verdictNoData: "NO DATA FOR THIS AREA",
  verdictOutside: "OUTSIDE COVERED AREA",
  verdictOnLand: "ON LAND",

  // --- compass -------------------------------------------------------------
  dirN: "NORTH", dirNNE: "NORTH-NORTH-EAST", dirNE: "NORTH-EAST", dirENE: "EAST-NORTH-EAST",
  dirE: "EAST", dirESE: "EAST-SOUTH-EAST", dirSE: "SOUTH-EAST", dirSSE: "SOUTH-SOUTH-EAST",
  dirS: "SOUTH", dirSSW: "SOUTH-SOUTH-WEST", dirSW: "SOUTH-WEST", dirWSW: "WEST-SOUTH-WEST",
  dirW: "WEST", dirWNW: "WEST-NORTH-WEST", dirNW: "NORTH-WEST", dirNNW: "NORTH-NORTH-WEST",

  // --- place types ---------------------------------------------------------
  typeCycloneShelter: "cyclone shelter",
  typeShelter: "shelter",
  typeAssemblyPoint: "assembly point",
  typeSchool: "school",
  typeHospital: "hospital",
  typeLandingCentre: "landing centre",

  // --- the language chooser ------------------------------------------------
  languageLabel: "Language",
  unreviewedWarning:
    "This translation has NOT been checked by a native speaker. If anything " +
    "reads wrongly, trust the English.",
} as const;

export type Key = keyof typeof en;
type Table = Partial<Record<Key, string>>;

// --- Malayalam. UNREVIEWED. -------------------------------------------------
const ml: Table = {
  escapeTitle: "സുരക്ഷിത സ്ഥലം",
  close: "അടയ്ക്കുക",
  escapeOpenWord: "രക്ഷപ്പെടുക",
  escapeOpenSub: "അടുത്ത സുരക്ഷിത സ്ഥലം · ഇന്റർനെറ്റ് ഇല്ലാതെ പ്രവർത്തിക്കും",

  gpsSearching: "നിങ്ങളുടെ സ്ഥാനം കണ്ടെത്തുന്നു… (ജിപിഎസ് ഇന്റർനെറ്റ് ഇല്ലാതെ പ്രവർത്തിക്കും)",
  gpsOk: "സ്ഥാനം: ജിപിഎസ്, ഏകദേശം {m} മീറ്റർ കൃത്യത. ഇന്റർനെറ്റ് ഇല്ലാതെ പ്രവർത്തിക്കും.",
  gpsManual:
    "കൈകൊണ്ട് നൽകിയ സ്ഥാനം, ജിപിഎസ് അല്ല. ദിശകൾ നിങ്ങൾ തിരഞ്ഞെടുത്ത സ്ഥലത്തുനിന്നാണ് " +
    "അളക്കുന്നത്, നിങ്ങൾ നിൽക്കുന്നിടത്തുനിന്നല്ല.",
  gpsDenied:
    "ഈ ആപ്പിന് സ്ഥാന അനുമതി ഇല്ല. ബ്രൗസർ ക്രമീകരണത്തിൽ ഓണാക്കുക, അല്ലെങ്കിൽ താഴെ " +
    "നിങ്ങളുടെ സ്ഥലം കൈകൊണ്ട് തിരഞ്ഞെടുക്കുക.",
  gpsTimeout:
    "ജിപിഎസ് ലഭിച്ചിട്ടില്ല. ആകാശം കാണാവുന്ന തുറസ്സായ സ്ഥലത്തേക്ക് പോകുക, അല്ലെങ്കിൽ " +
    "താഴെ നിങ്ങളുടെ സ്ഥലം കൈകൊണ്ട് തിരഞ്ഞെടുക്കുക.",
  gpsUnavailable:
    "ഈ ഉപകരണത്തിന് സ്ഥാനം നൽകാൻ കഴിയില്ല. താഴെ നിങ്ങളുടെ സ്ഥലം കൈകൊണ്ട് തിരഞ്ഞെടുക്കുക.",

  go: "{direction} ദിശയിൽ പോകുക",
  straightLineWarning: "നേർരേഖയിലുള്ള ദിശ. റോഡുകളും ഔദ്യോഗിക നിർദ്ദേശങ്ങളും പിന്തുടരുക.",
  compassLive: "അമ്പ് നിങ്ങളുടെ ഫോണിനെ പിന്തുടരുന്നു. ഫോൺ നിരപ്പായി പിടിക്കുക.",
  compassNone:
    "വടക്ക് മുകളിലാണ്. ഈ ഉപകരണത്തിൽ കോമ്പസ് ഇല്ല, അതിനാൽ അമ്പ് ഭൂപടത്തിലെ ദിശയാണ്, " +
    "ഫോൺ ചൂണ്ടിക്കാണിക്കാനുള്ള അമ്പല്ല.",

  manualSummary: "ജിപിഎസ് ഇല്ലേ? നിങ്ങളുടെ സ്ഥലം കൈകൊണ്ട് തിരഞ്ഞെടുക്കുക",
  manualUse: "ഈ സ്ഥലം ഉപയോഗിക്കുക",

  noPlaceList: "ഈ ഉപകരണത്തിൽ സ്ഥലങ്ങളുടെ പട്ടിക ഇല്ല",
  noPlaceListHelp: "ഒരിക്കൽ ഇന്റർനെറ്റ് ഉള്ളപ്പോൾ ആപ്പ് തുറന്ന് അത് ഡൗൺലോഡ് ചെയ്യുക.",
  noPlaceListShort: "ഈ ഉപകരണത്തിൽ സ്ഥലങ്ങളുടെ പട്ടിക ഇല്ല.",
  waitingForFix: "അടുത്തുള്ള സ്ഥലങ്ങൾ കണക്കാക്കാൻ സ്ഥാനം ലഭിക്കുന്നതുവരെ കാത്തിരിക്കുന്നു.",
  nothingClose:
    "അടുത്തൊന്നും ഇല്ല. ഏറ്റവും അടുത്തത് {km} അകലെയാണ്, നടന്നാൽ {time}. എന്നിരുന്നാലും കാണിക്കുന്നു.",

  onFoot: "നടന്നാൽ കുറഞ്ഞത് {time}",
  aboveSeaShort: "സമുദ്രനിരപ്പിൽ നിന്ന് {m} മീ",
  aboveSeaLong: "നിലം സമുദ്രനിരപ്പിൽ നിന്ന് {m} മീറ്റർ ഉയരത്തിൽ",
  walkSuffix: "{time}+ നടത്തം",

  mapNeedsFix: "സ്ഥാനം ലഭിച്ചാൽ ഭൂപടം കാണാം.",
  mapNeedsFixHelp: "സ്ഥാന അനുമതി നൽകുക, അല്ലെങ്കിൽ താഴെ സ്ഥലം കൈകൊണ്ട് തിരഞ്ഞെടുക്കുക.",
  mapNoPlaces: "ഭൂപടത്തിൽ കാണിക്കാൻ സ്ഥലങ്ങളില്ല.",
  mapNoPlacesHelp: "ഒരിക്കൽ ഇന്റർനെറ്റ് ഉള്ളപ്പോൾ ആപ്പ് തുറക്കുക.",

  notRegister:
    "ഇവ സമൂഹം രേഖപ്പെടുത്തിയ കെട്ടിടങ്ങളാണ്, ഔദ്യോഗിക അഭയകേന്ദ്ര പട്ടികയല്ല. ഇവ " +
    "തുറന്നിട്ടുണ്ടോ, ആളുകളുണ്ടോ, വെള്ളത്തിന് മുകളിലാണോ, നിലനിൽക്കുന്നുണ്ടോ എന്ന് " +
    "ആരും പരിശോധിച്ചിട്ടില്ല.",

  verdictSafe: "പോകാൻ സുരക്ഷിതം",
  verdictCaution: "ജാഗ്രത",
  verdictDanger: "പുറത്തുപോകരുത്",
  verdictNoData: "ഈ പ്രദേശത്തിന് വിവരമില്ല",
  verdictOutside: "പരിധിക്ക് പുറത്ത്",
  verdictOnLand: "കരയിലാണ്",

  dirN: "വടക്ക്", dirNNE: "വടക്ക്-വടക്കുകിഴക്ക്", dirNE: "വടക്കുകിഴക്ക്",
  dirENE: "കിഴക്ക്-വടക്കുകിഴക്ക്", dirE: "കിഴക്ക്", dirESE: "കിഴക്ക്-തെക്കുകിഴക്ക്",
  dirSE: "തെക്കുകിഴക്ക്", dirSSE: "തെക്ക്-തെക്കുകിഴക്ക്", dirS: "തെക്ക്",
  dirSSW: "തെക്ക്-തെക്കുപടിഞ്ഞാറ്", dirSW: "തെക്കുപടിഞ്ഞാറ്",
  dirWSW: "പടിഞ്ഞാറ്-തെക്കുപടിഞ്ഞാറ്", dirW: "പടിഞ്ഞാറ്",
  dirWNW: "പടിഞ്ഞാറ്-വടക്കുപടിഞ്ഞാറ്", dirNW: "വടക്കുപടിഞ്ഞാറ്",
  dirNNW: "വടക്ക്-വടക്കുപടിഞ്ഞാറ്",

  typeCycloneShelter: "ചുഴലിക്കാറ്റ് അഭയകേന്ദ്രം",
  typeShelter: "അഭയകേന്ദ്രം",
  typeAssemblyPoint: "ഒത്തുചേരൽ സ്ഥലം",
  typeSchool: "സ്കൂൾ",
  typeHospital: "ആശുപത്രി",
  typeLandingCentre: "മത്സ്യബന്ധന കേന്ദ്രം",

  languageLabel: "ഭാഷ",
  unreviewedWarning:
    "ഈ വിവർത്തനം ഒരു മാതൃഭാഷക്കാരൻ പരിശോധിച്ചിട്ടില്ല. എന്തെങ്കിലും തെറ്റായി " +
    "തോന്നിയാൽ ഇംഗ്ലീഷ് വിശ്വസിക്കുക.",
};

// --- Tamil. UNREVIEWED. -----------------------------------------------------
const ta: Table = {
  escapeTitle: "பாதுகாப்பான இடம்",
  close: "மூடு",
  escapeOpenWord: "தப்பிக்க",
  escapeOpenSub: "அருகிலுள்ள பாதுகாப்பான இடம் · இணையம் இல்லாமல் இயங்கும்",

  gpsSearching: "உங்கள் இருப்பிடத்தைக் கண்டறிகிறது… (ஜிபிஎஸ் இணையம் இல்லாமல் இயங்கும்)",
  gpsOk: "இருப்பிடம்: ஜிபிஎஸ், ஏறத்தாழ {m} மீட்டர் துல்லியம். இணையம் இல்லாமல் இயங்கும்.",
  gpsManual:
    "கைமுறை இருப்பிடம், ஜிபிஎஸ் அல்ல. திசைகள் நீங்கள் தேர்ந்தெடுத்த இடத்திலிருந்து " +
    "அளக்கப்படுகின்றன, நீங்கள் நிற்கும் இடத்திலிருந்து அல்ல.",
  gpsDenied:
    "இந்த ஆப்ஸுக்கு இருப்பிட அனுமதி இல்லை. உலாவி அமைப்புகளில் இயக்கவும், அல்லது " +
    "கீழே உங்கள் இடத்தைக் கைமுறையாகத் தேர்ந்தெடுக்கவும்.",
  gpsTimeout:
    "ஜிபிஎஸ் இன்னும் கிடைக்கவில்லை. வானம் தெரியும் திறந்தவெளிக்குச் செல்லவும், அல்லது " +
    "கீழே உங்கள் இடத்தைக் கைமுறையாகத் தேர்ந்தெடுக்கவும்.",
  gpsUnavailable:
    "இந்தச் சாதனத்தால் இருப்பிடத்தைத் தர முடியாது. கீழே உங்கள் இடத்தைக் கைமுறையாகத் " +
    "தேர்ந்தெடுக்கவும்.",

  go: "{direction} திசையில் செல்லுங்கள்",
  straightLineWarning: "நேர்கோட்டுத் திசை. சாலைகளையும் அதிகாரப்பூர்வ அறிவுறுத்தல்களையும் பின்பற்றவும்.",
  compassLive: "அம்பு உங்கள் தொலைபேசியைப் பின்தொடர்கிறது. தொலைபேசியைத் தட்டையாகப் பிடிக்கவும்.",
  compassNone:
    "வடக்கு மேலே. இந்தச் சாதனத்தில் திசைகாட்டி இல்லை, எனவே அம்பு வரைபடத் திசையே, " +
    "தொலைபேசியைச் சுட்டிக்காட்டும் அம்பு அல்ல.",

  manualSummary: "ஜிபிஎஸ் இல்லையா? உங்கள் இடத்தைக் கைமுறையாகத் தேர்ந்தெடுக்கவும்",
  manualUse: "இந்த இடத்தைப் பயன்படுத்து",

  noPlaceList: "இந்தச் சாதனத்தில் இடங்களின் பட்டியல் இல்லை",
  noPlaceListHelp: "இணையம் உள்ளபோது ஒருமுறை ஆப்ஸைத் திறந்து பதிவிறக்கவும்.",
  noPlaceListShort: "இந்தச் சாதனத்தில் இடங்களின் பட்டியல் இல்லை.",
  waitingForFix: "அருகிலுள்ள இடங்களைக் கணக்கிட இருப்பிடம் கிடைக்கக் காத்திருக்கிறது.",
  nothingClose:
    "அருகில் எதுவும் இல்லை. அருகிலுள்ளது {km} தொலைவில், நடந்தால் {time}. இருப்பினும் காட்டப்படுகிறது.",

  onFoot: "நடந்தால் குறைந்தது {time}",
  aboveSeaShort: "கடல் மட்டத்திலிருந்து {m} மீ",
  aboveSeaLong: "தரை கடல் மட்டத்திலிருந்து {m} மீட்டர் உயரத்தில்",
  walkSuffix: "{time}+ நடை",

  mapNeedsFix: "இருப்பிடம் கிடைத்ததும் வரைபடம் தோன்றும்.",
  mapNeedsFixHelp: "இருப்பிட அனுமதி அளிக்கவும், அல்லது கீழே இடத்தைக் கைமுறையாகத் தேர்ந்தெடுக்கவும்.",
  mapNoPlaces: "வரைபடத்தில் காட்ட இடங்கள் இல்லை.",
  mapNoPlacesHelp: "இணையம் உள்ளபோது ஒருமுறை ஆப்ஸைத் திறக்கவும்.",

  notRegister:
    "இவை சமூகத்தால் வரைபடத்தில் குறிக்கப்பட்ட கட்டிடங்கள், அதிகாரப்பூர்வ முகாம் பட்டியல் " +
    "அல்ல. இவை திறந்திருக்கிறதா, பணியாளர்கள் உள்ளனரா, நீருக்கு மேலே உள்ளதா, இன்னும் " +
    "நிற்கிறதா என்பதை யாரும் சரிபார்க்கவில்லை.",

  verdictSafe: "வெளியே செல்ல பாதுகாப்பானது",
  verdictCaution: "எச்சரிக்கை",
  verdictDanger: "வெளியே செல்ல வேண்டாம்",
  verdictNoData: "இந்தப் பகுதிக்குத் தரவு இல்லை",
  verdictOutside: "பாதுகாக்கப்பட்ட பகுதிக்கு வெளியே",
  verdictOnLand: "நிலத்தில்",

  dirN: "வடக்கு", dirNNE: "வடக்கு-வடகிழக்கு", dirNE: "வடகிழக்கு",
  dirENE: "கிழக்கு-வடகிழக்கு", dirE: "கிழக்கு", dirESE: "கிழக்கு-தென்கிழக்கு",
  dirSE: "தென்கிழக்கு", dirSSE: "தெற்கு-தென்கிழக்கு", dirS: "தெற்கு",
  dirSSW: "தெற்கு-தென்மேற்கு", dirSW: "தென்மேற்கு", dirWSW: "மேற்கு-தென்மேற்கு",
  dirW: "மேற்கு", dirWNW: "மேற்கு-வடமேற்கு", dirNW: "வடமேற்கு",
  dirNNW: "வடக்கு-வடமேற்கு",

  typeCycloneShelter: "புயல் முகாம்",
  typeShelter: "தங்குமிடம்",
  typeAssemblyPoint: "ஒன்றுகூடும் இடம்",
  typeSchool: "பள்ளி",
  typeHospital: "மருத்துவமனை",
  typeLandingCentre: "மீன்பிடி தளம்",

  languageLabel: "மொழி",
  unreviewedWarning:
    "இந்த மொழிபெயர்ப்பைத் தாய்மொழி பேசுபவர் சரிபார்க்கவில்லை. ஏதேனும் தவறாகத் " +
    "தோன்றினால் ஆங்கிலத்தை நம்புங்கள்.",
};

// --- Hindi. UNREVIEWED. -----------------------------------------------------
const hi: Table = {
  escapeTitle: "सुरक्षित स्थान",
  close: "बंद करें",
  escapeOpenWord: "बचाव",
  escapeOpenSub: "निकटतम सुरक्षित स्थान · बिना इंटरनेट काम करता है",

  gpsSearching: "आपका स्थान खोजा जा रहा है… (जीपीएस बिना इंटरनेट काम करता है)",
  gpsOk: "स्थान: जीपीएस, लगभग {m} मीटर सटीकता। बिना इंटरनेट काम करता है।",
  gpsManual:
    "हाथ से चुना गया स्थान, जीपीएस नहीं। दिशाएँ आपके चुने हुए स्थान से मापी जा रही हैं, " +
    "जहाँ आप खड़े हैं वहाँ से नहीं।",
  gpsDenied:
    "इस ऐप के लिए स्थान बंद है। ब्राउज़र सेटिंग्स में चालू करें, या नीचे अपना स्थान " +
    "हाथ से चुनें।",
  gpsTimeout:
    "अभी तक जीपीएस नहीं मिला। खुले आसमान के नीचे जाएँ, या नीचे अपना स्थान हाथ से चुनें।",
  gpsUnavailable: "यह डिवाइस स्थान नहीं दे सकता। नीचे अपना स्थान हाथ से चुनें।",

  go: "{direction} दिशा में जाएँ",
  straightLineWarning: "सीधी रेखा की दिशा। सड़कों और आधिकारिक निर्देशों का पालन करें।",
  compassLive: "तीर आपके फ़ोन के साथ घूमता है। फ़ोन को समतल पकड़ें।",
  compassNone:
    "उत्तर ऊपर है। इस डिवाइस में कम्पास नहीं है, इसलिए तीर नक्शे की दिशा है, " +
    "फ़ोन घुमाकर देखने वाला तीर नहीं।",

  manualSummary: "जीपीएस नहीं? अपना स्थान हाथ से चुनें",
  manualUse: "यही स्थान चुनें",

  noPlaceList: "इस डिवाइस में स्थानों की सूची नहीं है",
  noPlaceListHelp: "इंटरनेट रहते हुए एक बार ऐप खोलकर इसे डाउनलोड करें।",
  noPlaceListShort: "इस डिवाइस में स्थानों की सूची नहीं है।",
  waitingForFix: "निकटतम स्थान निकालने के लिए स्थान मिलने का इंतज़ार है।",
  nothingClose:
    "पास में कुछ नहीं है। निकटतम {km} दूर है, पैदल {time}। फिर भी दिखाया जा रहा है।",

  onFoot: "पैदल कम से कम {time}",
  aboveSeaShort: "समुद्र तल से {m} मी",
  aboveSeaLong: "ज़मीन समुद्र तल से {m} मीटर ऊपर",
  walkSuffix: "{time}+ पैदल",

  mapNeedsFix: "स्थान मिलते ही नक्शा दिखेगा।",
  mapNeedsFixHelp: "स्थान की अनुमति दें, या नीचे स्थान हाथ से चुनें।",
  mapNoPlaces: "नक्शे पर दिखाने के लिए कोई स्थान नहीं।",
  mapNoPlacesHelp: "इंटरनेट रहते हुए एक बार ऐप खोलें।",

  notRegister:
    "ये समुदाय द्वारा मानचित्रित इमारतें हैं, कोई आधिकारिक शरण-स्थल सूची नहीं। किसी ने " +
    "जाँचा नहीं है कि ये खुली हैं, वहाँ कर्मचारी हैं, पानी से ऊपर हैं या अब भी खड़ी हैं।",

  verdictSafe: "बाहर जाना सुरक्षित",
  verdictCaution: "सावधान",
  verdictDanger: "बाहर मत जाइए",
  verdictNoData: "इस क्षेत्र के लिए जानकारी नहीं",
  verdictOutside: "कवर किए गए क्षेत्र से बाहर",
  verdictOnLand: "ज़मीन पर",

  dirN: "उत्तर", dirNNE: "उत्तर-उत्तर-पूर्व", dirNE: "उत्तर-पूर्व",
  dirENE: "पूर्व-उत्तर-पूर्व", dirE: "पूर्व", dirESE: "पूर्व-दक्षिण-पूर्व",
  dirSE: "दक्षिण-पूर्व", dirSSE: "दक्षिण-दक्षिण-पूर्व", dirS: "दक्षिण",
  dirSSW: "दक्षिण-दक्षिण-पश्चिम", dirSW: "दक्षिण-पश्चिम",
  dirWSW: "पश्चिम-दक्षिण-पश्चिम", dirW: "पश्चिम", dirWNW: "पश्चिम-उत्तर-पश्चिम",
  dirNW: "उत्तर-पश्चिम", dirNNW: "उत्तर-उत्तर-पश्चिम",

  typeCycloneShelter: "चक्रवात आश्रय",
  typeShelter: "आश्रय",
  typeAssemblyPoint: "एकत्र होने का स्थान",
  typeSchool: "स्कूल",
  typeHospital: "अस्पताल",
  typeLandingCentre: "मत्स्य केंद्र",

  languageLabel: "भाषा",
  unreviewedWarning:
    "इस अनुवाद की जाँच किसी मूल वक्ता ने नहीं की है। कुछ भी ग़लत लगे तो अंग्रेज़ी पर " +
    "भरोसा करें।",
};

export const STRINGS: Record<LanguageCode, Table & typeof en | Table> = {
  en,
  ml,
  ta,
  hi,
};
