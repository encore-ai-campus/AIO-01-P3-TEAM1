import json


def test_index_is_empty_page(client):
    response = client.get("/")
    assert response.status_code == 200
    content = response.content.decode()
    assert "<title>모의매매</title>" in content
    assert "<body></body>" in content


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert json.loads(response.content) == {"status": "ok"}


def test_schema(client):
    response = client.get("/api/schema/")
    assert response.status_code == 200
