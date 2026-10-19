"""#342 PR-4: Python copy of managed_knowledge_private.entity_kind_v1 (same table as the SQL migration and legacyEntityTypeToKindV1)."""
import re
KIND_MAP = {
  'person': ['person'],
  'organization': ['organization', 'company', 'group', 'exchange', 'government_agency', 'data_provider'],
  'network': ['network'],
  'protocol': ['protocol', 'project', 'crypto_project'],
  'product': ['product', 'ai_model', 'platform', 'software_application', 'ai_coding_tool', 'ai_agent_app'],
  'asset': ['asset', 'commodity', 'currency', 'index', 'instrument', 'asset_class', 'cryptoasset', 'financial_instrument', 'exchange_traded_fund'],
  'place': ['country', 'nation', 'geo', 'place', 'location'],
  'event': ['event', 'conflict', 'election'],
  'topic': ['topic', 'market_theme', 'sector', 'indicator', 'geopolitical_topic', 'event_market', 'market'],
  'regulation': ['regulation', 'legislation', 'regulation_or_initiative', 'proposed_government_payment_program'],
  'unclassified': ['unclassified', 'trader', 'wallet', 'wallet_or_trader'],
}
_LOOKUP = {v: k for k, vs in KIND_MAP.items() for v in vs}
def kind_v1(t):
    n = re.sub(r'[\s-]+', '_', (t or '').strip().lower())
    return _LOOKUP.get(n, 'unclassified')

LEGAL = re.compile(r'[\s,]+(inc|ltd|corp|labs)\.?$', re.I)
def name_key(name):
    import unicodedata
    b = unicodedata.normalize('NFKC', name or '').strip()
    s = re.sub(r'\s*\([^()]*\)$', '', b)
    if s: b = s
    return re.sub(r'[^0-9a-z]+', '', b.lower()) if b.isascii() else re.sub(r'[\W_]+', '', b.lower())
def compare_key(name):
    s = LEGAL.sub('', (name or '').strip())
    return name_key(s if s else name)

def trigrams(k):
    p = '  ' + k + ' '
    return {p[i:i+3] for i in range(len(p) - 2)}
def similarity(a, b):
    if not a or not b: return 0.0
    A, B = trigrams(a), trigrams(b); s = len(A & B)
    return s / (len(A) + len(B) - s)
