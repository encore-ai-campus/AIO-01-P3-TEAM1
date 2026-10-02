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


def test_schema_requires_login(client, django_user_model):
    assert client.get("/api/schema/").status_code == 401
    client.force_login(django_user_model.objects.create_user("alice", password="pw-alice-1234"))
    response = client.get("/api/schema/")
    assert response.status_code == 200 and b"/api/auth/login" in response.content
