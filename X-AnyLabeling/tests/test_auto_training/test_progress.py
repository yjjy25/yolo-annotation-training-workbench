from types import SimpleNamespace
from anylabeling.services.auto_training.ultralytics import worker


def test_progress_includes_validation_time_and_ignores_final_evaluation(monkeypatch):
    now = [100.0]
    events, callbacks = [], {}
    monkeypatch.setattr(worker.time, 'monotonic', lambda: now[0])
    monkeypatch.setattr(worker, 'emit', lambda event, **data: events.append(data))
    worker.attach_training_progress(SimpleNamespace(add_callback=lambda name, callback: callbacks.update({name: callback})))
    trainer = SimpleNamespace(epoch=0, epochs=4, train_loader=[0, 1])
    callbacks['on_train_epoch_start'](trainer)
    assert events[-1]['eta_seconds'] is None
    now[0] += 4
    callbacks['on_train_batch_end'](trainer)
    assert 0 < events[-1]['completed'] < 1
    now[0] += 4
    callbacks['on_train_batch_end'](trainer)
    assert events[-1]['phase'] == 'validating'
    now[0] += 2
    callbacks['on_fit_epoch_end'](trainer)
    assert events[-1]['completed'] == 1
    assert events[-1]['eta_seconds'] == 30  # 10 seconds including validation, 3 epochs left
    trainer.epoch = 1
    callbacks['on_fit_epoch_end'](trainer)  # final best-model evaluation hook
    assert events[-1]['completed'] == 1
    callbacks['on_train_epoch_start'](trainer)
    now[0] += 6
    callbacks['on_fit_epoch_end'](trainer)
    assert events[-1]['eta_seconds'] == 16  # rolling mean adapts to faster epochs
