# 上游与第三方组件

本工作台基于 X-AnyLabeling 扩展，源码采用 GPL-3.0-only；完整许可见根目录 LICENSE。保留上游作者、版权声明与 X-AnyLabeling/LICENSE。上游基线为 https://github.com/CVHub520/X-AnyLabeling 的 745f6c355f94cddb06f6965b3a4118f82033e935。

Electron、Chromium、Python、PyQt6、PyTorch、Ultralytics、ONNX Runtime、NVIDIA CUDA 库等组件遵循各自许可。二进制包保留对应运行库的 LICENSE、NOTICE 和 dist-info 许可文件；源码包不包含这些大型运行库。Noto Sans SC 字体采用 SIL Open Font License，见 .runtime/fonts/OFL.txt。

预训练权重来自 Ultralytics 官方发布，使用和再分发须遵循其对应许可。源码包不包含权重、个人项目和训练数据。发布二进制时应同时提供该版本完整对应源码和本说明；本清单不替代各组件原始许可。
