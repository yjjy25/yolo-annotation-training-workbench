# 狗姿态照片教学参考

照片及前20点坐标取自 Ultralytics 官方 Dog-Pose 压缩包（源图为 Stanford Dogs / ImageNet），未修改照片像素。完整来源成员路径、原始 YOLO 数组及图片 SHA256 保存在 dog24-examples.json。

来源文档：https://docs.ultralytics.com/datasets/pose/dog-pose/
数据包：https://github.com/ultralytics/assets/releases/download/v0.0.0/dog-pose.zip
Stanford Dogs：http://vision.stanford.edu/aditya86/ImageNetDogs/

该包末尾4个点均没有有效原始坐标。此处21–24是人工教学定位、用于说明眼睛/肩隆/喉部的大致解剖位置，存储标记 teaching_reference=true，显示为橙色，不应当作数据集真值或直接用于训练。其余20点保留原始标注；整个参考目录不自动导入用户数据集。

请遵循原始数据来源的研究用途及相应许可要求。图片只用于本地教学参考，分发产品前应确认相应图片使用权。
