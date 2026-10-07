"""실행 계획에 선언된 Worker와 Python 구현의 계약이 일치한다."""

from reports.agents import WORKERS
from reports.registry import execution_plan


def test_every_planned_worker_is_registered_with_matching_contract_and_model():
    planned = {worker["id"]: worker for worker in execution_plan()["workers"]}

    assert set(WORKERS) == set(planned)
    for worker_id, worker in WORKERS.items():
        definition = planned[worker_id]
        assert worker.id == worker_id
        assert worker.output_contract == definition["outputContract"]
        assert definition["provider"] == "devpass"
        assert definition["model"]
        assert len(definition["fallbacks"]) == 1
        assert definition["fallbacks"][0] in {
            "gpt-5.6-luna", "gemini-3.8-flash", "deepseek-v4.1-flash",
        }
        assert definition["model"] not in definition["fallbacks"]
