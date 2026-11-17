// rarext-matvec — an OPTIONAL host accelerator for RAREXT's engine.
//
// The engine artifact is pure JS and runs with nothing but the provider. When a
// host offers this addon, the engine routes its dense matrix-vector products
// through the platform BLAS (Accelerate on macOS), which uses the CPU's vector
// units instead of one scalar JavaScript multiply-add at a time. Without it the
// engine takes the identical JS path; nothing about the model, the tokenizer or
// the trace changes.
//
// ABI: matvec(A, rows, cols, x, y)
//   A  Float32Array, row-major, rows*cols
//   x  Float32Array, cols
//   y  Float32Array, rows (written)
//
// The arrays are read in place; no copy crosses the boundary.
#include <node_api.h>
#include <Accelerate/Accelerate.h>

static int float32_view(napi_env env, napi_value value, void **data, size_t *length) {
  napi_typedarray_type type;
  napi_value buffer;
  size_t offset = 0;
  if (napi_get_typedarray_info(env, value, &type, length, data, &buffer, &offset) != napi_ok) {
    return 0;
  }
  return type == napi_float32_array;
}

static napi_value Matvec(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 5) {
    napi_throw_type_error(env, NULL, "matvec(A, rows, cols, x, y) needs five arguments");
    return NULL;
  }
  void *a = NULL;
  void *x = NULL;
  void *y = NULL;
  size_t aLen = 0;
  size_t xLen = 0;
  size_t yLen = 0;
  if (!float32_view(env, argv[0], &a, &aLen) || !float32_view(env, argv[3], &x, &xLen) ||
      !float32_view(env, argv[4], &y, &yLen)) {
    napi_throw_type_error(env, NULL, "matvec expects Float32Array for A, x and y");
    return NULL;
  }
  int32_t rows = 0;
  int32_t cols = 0;
  if (napi_get_value_int32(env, argv[1], &rows) != napi_ok ||
      napi_get_value_int32(env, argv[2], &cols) != napi_ok) {
    napi_throw_type_error(env, NULL, "matvec expects integer rows and cols");
    return NULL;
  }
  if (rows <= 0 || cols <= 0 || (size_t)rows * (size_t)cols > aLen || (size_t)cols > xLen ||
      (size_t)rows > yLen) {
    napi_throw_range_error(env, NULL, "matvec shapes do not match the arrays");
    return NULL;
  }
  cblas_sgemv(CblasRowMajor, CblasNoTrans, rows, cols, 1.0f, (const float *)a, cols,
              (const float *)x, 1, 0.0f, (float *)y, 1);
  return NULL;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  if (napi_create_function(env, "matvec", NAPI_AUTO_LENGTH, Matvec, NULL, &fn) != napi_ok) {
    return NULL;
  }
  napi_set_named_property(env, exports, "matvec", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
