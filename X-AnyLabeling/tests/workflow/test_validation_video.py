from pathlib import Path
import cv2
import numpy as np
import pytest
from anylabeling.services.workflow.validate import render_video_predictions


def clip(folder):
    source = folder / 'source.avi'
    writer = cv2.VideoWriter(str(source), cv2.VideoWriter_fourcc(*'MJPG'), 10, (80, 60))
    assert writer.isOpened()
    for _ in range(12):
        writer.write(np.full((60, 80, 3), 30, dtype=np.uint8))
    writer.release()
    return source


class Result:
    def plot(self):
        image = np.full((60, 80, 3), 30, dtype=np.uint8)
        cv2.rectangle(image, (10, 10), (50, 40), (0, 255, 0), 3)
        return image


def test_complete_playable_video_retains_timing_and_overlay(tmp_path):
    source = clip(tmp_path)
    results = [Result() for _ in range(12)]
    assert list(render_video_predictions(iter(results), source, tmp_path, .5)) == results
    capture = cv2.VideoCapture(str(tmp_path / 'predictions.webm'))
    assert capture.isOpened()
    assert capture.get(cv2.CAP_PROP_FPS) == pytest.approx(10)
    frames = []
    while True:
        ok, image = capture.read()
        if not ok:
            break
        frames.append(image)
    capture.release()
    assert len(frames) == 12
    assert frames[0].shape[:2] == (60, 80)
    assert frames[0][10, 20, 1] > 170  # plotted green box is in the encoded video
    assert len(list(tmp_path.glob('video_frame_*.jpg'))) == 3
    assert not (tmp_path / 'predictions.partial.webm').exists()


def test_failed_predictions_do_not_publish_partial_video(tmp_path):
    source = clip(tmp_path)
    def broken():
        yield Result()
        raise ValueError('inference interrupted')
    with pytest.raises(ValueError, match='interrupted'):
        list(render_video_predictions(broken(), source, tmp_path))
    assert not list(tmp_path.glob('*.webm'))


def test_no_frames_reports_failure_and_no_screenshots_option(tmp_path):
    source = clip(tmp_path)
    with pytest.raises(ValueError, match='没有取到'):
        list(render_video_predictions(iter([]), source, tmp_path))
    list(render_video_predictions(iter([Result()]), source, tmp_path, None))
    assert not list(tmp_path.glob('video_frame_*.jpg'))
