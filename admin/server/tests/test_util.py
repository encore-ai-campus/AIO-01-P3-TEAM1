"""오류 문장 다듬기: URL 경로·쿼리와 스킴 없는 웹훅 경로를 가린다."""
from paper_admin.util import clean_text


def test_masks_url_and_schemeless_webhook_path():
    text = ("HTTPSConnectionPool(host='discord.com', port=443): Max retries exceeded with url: /api/webhooks/123/SECRET?wait=true "
            "· https://discord.com/api/v10/webhooks/9/TOKEN2")
    cleaned = clean_text(text)
    assert "SECRET" not in cleaned and "TOKEN2" not in cleaned
    assert "url: /api/webhooks/…" in cleaned and "https://discord.com/…" in cleaned
