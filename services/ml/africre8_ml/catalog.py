"""Curated example name pools, locations and content topics; not population estimates.

Name pools provide coherent fictional names. Residence, niche, audience, reliability
and appearance are not inferred from names or ancestry.
"""
COMMUNITIES = [
    ("Lagos", "Nigeria", "NG", "NGN", ["en", "yo"], ["Tunde", "Bisi", "Temi", "Seyi", "Kemi"], ["Adeyemi", "Adebayo", "Olawale", "Adesina", "Akinola"]),
    ("Enugu", "Nigeria", "NG", "NGN", ["en", "ig"], ["Amara", "Chidi", "Ada", "Emeka", "Ifeoma"], ["Okoye", "Eze", "Okafor", "Nwosu", "Obi"]),
    ("Accra", "Ghana", "GH", "GHS", ["en", "ak"], ["Ama", "Kofi", "Akua", "Kwame", "Abena"], ["Mensah", "Owusu", "Asante", "Boateng", "Osei"]),
    ("Nairobi", "Kenya", "KE", "KES", ["sw", "en"], ["Wanjiru", "Njeri", "Kamau", "Wambui", "Kariuki"], ["Mwangi", "Njoroge", "Maina", "Karanja", "Gichuki"]),
    ("Johannesburg", "South Africa", "ZA", "ZAR", ["zu", "en"], ["Zanele", "Sipho", "Thandi", "Bongani", "Nomsa"], ["Dlamini", "Zulu", "Khumalo", "Mthembu", "Ndlovu"]),
    ("Cape Town", "South Africa", "ZA", "ZAR", ["xh", "en"], ["Lulama", "Ayanda", "Sive", "Lukhanyo", "Zola"], ["Mbeki", "Mabaso", "Mketeni", "Jali", "Maseko"]),
    ("Dakar", "Senegal", "SN", "XOF", ["wo", "fr"], ["Aminata", "Mamadou", "Awa", "Fatou", "Ousmane"], ["Diop", "Ndiaye", "Sarr", "Fall", "Seck"]),
    ("Kigali", "Rwanda", "RW", "RWF", ["rw", "en"], ["Aline", "Eric", "Diane", "Jean", "Chantal"], ["Mugisha", "Uwimana", "Niyonzima", "Mukamana", "Ishimwe"]),
    ("Kampala", "Uganda", "UG", "UGX", ["lg", "en"], ["David", "Sarah", "Brian", "Grace", "Peter"], ["Ssemakula", "Namusoke", "Kato", "Nakato", "Mugisha"]),
    ("Addis Ababa", "Ethiopia", "ET", "ETB", ["am", "en"], ["Selam", "Dawit", "Hana", "Meron", "Samuel"], ["Bekele", "Tesfaye", "Tadesse", "Alemu", "Getachew"]),
    ("Cairo", "Egypt", "EG", "EGP", ["ar", "en"], ["Fatima", "Omar", "Mariam", "Youssef", "Salma"], ["Hassan", "Ibrahim", "Mahmoud", "Saleh", "Ali"]),
    ("Casablanca", "Morocco", "MA", "EUR", ["ar", "fr"], ["Yassine", "Salma", "Imane", "Anas", "Hajar"], ["Bennani", "Idrissi", "Alaoui", "El Amrani", "Berrada"]),
    ("Douala", "Cameroon", "CM", "EUR", ["fr", "en"], ["Marie", "Alain", "Estelle", "Patrick", "Carole"], ["Kamga", "Tchoumi", "Fokou", "Tchoua", "Nana"]),
    ("Kinshasa", "DR Congo", "CD", "USD", ["ln", "fr"], ["Chantal", "Patrick", "Grace", "Jean", "Nadine"], ["Ilunga", "Kabeya", "Mbuyi", "Kalala", "Tshibanda"]),
    ("Dar es Salaam", "Tanzania", "TZ", "USD", ["sw", "en"], ["Asha", "Juma", "Neema", "Hamisi", "Rehema"], ["Mussa", "Juma", "Mwakalinga", "Said", "Salum"]),
    ("Lusaka", "Zambia", "ZM", "USD", ["en", "bem"], ["Chanda", "Mutale", "Mwewa", "Bwalya", "Mulenga"], ["Banda", "Phiri", "Mwansa", "Chileshe", "Musonda"]),
    ("Harare", "Zimbabwe", "ZW", "USD", ["sn", "en"], ["Tendai", "Rudo", "Tariro", "Farai", "Nyasha"], ["Moyo", "Dube", "Ncube", "Sibanda", "Mawere"]),
    ("Gaborone", "Botswana", "BW", "ZAR", ["tn", "en"], ["Kagiso", "Naledi", "Thabo", "Mpho", "Lerato"], ["Molefe", "Mokoena", "Modise", "Moagi", "Motsumi"]),
    ("Abidjan", "Côte d’Ivoire", "CI", "XOF", ["fr"], ["Aya", "Kouadio", "Amani", "Akissi", "Yao"], ["Kouassi", "Koffi", "Konan", "N’Guessan", "Yao"]),
    ("Maputo", "Mozambique", "MZ", "USD", ["pt"], ["Ana", "João", "Celina", "Paulo", "Lúcia"], ["Mabunda", "Chissano", "Machel", "Mondlane", "Simango"]),
]
TOPICS = {
    "Fashion & Lifestyle": ["capsule wardrobes", "textile care", "streetwear"],
    "Tech & Gadgets": ["accessible devices", "software tutorials", "camera reviews"],
    "Food & Culinary": ["weeknight cooking", "restaurant stories", "baking"],
    "Fitness": ["mobility routines", "running", "home workouts"],
    "Comedy & Skits": ["workplace sketches", "observational comedy", "improvisation"],
    "Music": ["music production", "instrument tutorials", "live sessions"],
    "Travel": ["city guides", "responsible travel", "travel planning"],
    "Beauty": ["skincare routines", "haircare", "makeup tutorials"],
    "Finance & Fintech": ["budgeting education", "small-business tools", "saving habits"],
    "Parenting": ["family activities", "learning through play", "caregiver routines"],
    "Gaming": ["indie games", "esports commentary", "game accessibility"],
    "Art & Design": ["illustration", "product design", "photography"],
}
STYLES = ["documentary", "tutorial", "humorous", "interview", "cinematic", "product demonstration"]
PLATFORMS = ["instagram", "tiktok", "youtube", "x", "facebook"]
MARKETS = ["NG", "GH", "KE", "ZA", "SN", "RW", "UG", "ET", "EG", "MA", "CM", "CD", "TZ", "ZM", "ZW", "BW", "CI", "MZ", "US", "GB", "DE", "FR", "CA", "AE", "BR", "IN", "JP"]
PRODUCTS = ["editing software", "wireless headphones", "running shoes", "learning platform", "travel booking app", "skincare range", "kitchen equipment", "gaming accessories", "business software", "streaming subscription", "reusable drinkware", "clothing collection"]
