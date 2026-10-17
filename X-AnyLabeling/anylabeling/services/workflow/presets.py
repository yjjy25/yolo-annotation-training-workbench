"""Ordered presets. Dog ordering matches installed Ultralytics dog-pose.yaml.

References: https://docs.ultralytics.com/datasets/pose/coco/
https://docs.ultralytics.com/datasets/pose/dog-pose/
Connections/preview positions are local editing aids, not dataset ground truth.
"""
from copy import deepcopy

HUMAN = {
    "preset": "coco17", "class_name": "person",
    "points": ["nose", "left_eye", "right_eye", "left_ear", "right_ear", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle"],
    "display": ["鼻尖", "左眼", "右眼", "左耳", "右耳", "左肩", "右肩", "左肘", "右肘", "左腕", "右腕", "左髋", "右髋", "左膝", "右膝", "左踝", "右踝"],
    "edges": [[0,1],[0,2],[1,3],[2,4],[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16]],
    "pairs": [[1,2],[3,4],[5,6],[7,8],[9,10],[11,12],[13,14],[15,16]],
    "positions": [[.5,.12],[.45,.1],[.55,.1],[.4,.13],[.6,.13],[.37,.3],[.63,.3],[.28,.43],[.72,.43],[.2,.57],[.8,.57],[.42,.54],[.58,.54],[.39,.72],[.61,.72],[.36,.9],[.64,.9]],
}
DOG = {
    "preset": "dog24", "class_name": "dog",
    "points": ["front_left_paw", "front_left_knee", "front_left_elbow", "rear_left_paw", "rear_left_knee", "rear_left_elbow", "front_right_paw", "front_right_knee", "front_right_elbow", "rear_right_paw", "rear_right_knee", "rear_right_elbow", "tail_start", "tail_end", "left_ear_base", "right_ear_base", "nose", "chin", "left_ear_tip", "right_ear_tip", "left_eye", "right_eye", "withers", "throat"],
    "display": ["左前爪", "左前膝", "左前肘", "左后爪", "左后膝", "左后肘", "右前爪", "右前膝", "右前肘", "右后爪", "右后膝", "右后肘", "尾根", "尾尖", "左耳根", "右耳根", "鼻尖", "下巴", "左耳尖", "右耳尖", "左眼", "右眼", "肩隆", "喉部"],
    "edges": [[0,1],[1,2],[2,22],[3,4],[4,5],[5,12],[6,7],[7,8],[8,22],[9,10],[10,11],[11,12],[12,13],[12,22],[14,18],[15,19],[14,20],[15,21],[20,16],[21,16],[16,17],[17,23],[23,22]],
    "pairs": [[0,6],[1,7],[2,8],[3,9],[4,10],[5,11],[14,15],[18,19],[20,21]],
    "positions": [[.36,.84],[.36,.67],[.38,.52],[.72,.85],[.67,.68],[.69,.52],[.44,.8],[.44,.65],[.44,.5],[.8,.81],[.76,.66],[.75,.51],[.77,.38],[.94,.2],[.26,.22],[.33,.22],[.1,.35],[.18,.42],[.23,.1],[.34,.1],[.22,.31],[.3,.31],[.43,.36],[.31,.44]],
}


def preset(name):
    return deepcopy({"human": HUMAN, "dog": DOG}[name])
